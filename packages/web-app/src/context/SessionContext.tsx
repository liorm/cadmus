import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	fetchProvidersInfo,
	readMemberships,
	readPrincipal,
	refreshForBoot,
	type SessionMembership,
	type SessionPrincipal,
	type SessionTokens,
	selectAccount,
	selectedAccountId,
} from "@/lib/session";

export interface SessionState {
	/** True when a Cadmus session (not the no-session fallback) is active. */
	signedIn: boolean;
	providers: string[];
	principal: SessionPrincipal | null;
	tokens: SessionTokens | null;
	memberships: SessionMembership[];
	/** One line shown once when the app had to leave a remembered account. */
	notice?: string | null;
}

const SessionContext = createContext<SessionState>({
	signedIn: false,
	providers: [],
	principal: null,
	tokens: null,
	memberships: [],
});

export function useSession(): SessionState {
	return useContext(SessionContext);
}

/**
 * Resolves the session once at boot: tries the refresh cookie, then reads the
 * principal. With no session the router shows the login dialog. It does not
 * fall back to the master secret.
 */
export function SessionBoot({
	children,
}: {
	children: (state: SessionState) => ReactNode;
}) {
	const [state, setState] = useState<SessionState | null>(null);
	// "retrying": the session service said try again (rate limited or briefly
	// down). "unavailable": it still does after the bounded retries. Neither is
	// the signed-out view: whether a session exists is not known yet.
	const [phase, setPhase] = useState<"loading" | "retrying" | "unavailable">(
		"loading",
	);
	const cancelBoot = useRef<(() => void) | null>(null);
	const startBoot = useCallback(() => {
		cancelBoot.current?.();
		let cancelled = false;
		const abort = new AbortController();
		setPhase("loading");
		void (async () => {
			const providersPromise = fetchProvidersInfo();
			const [providersInfo, boot] = await Promise.all([
				providersPromise,
				refreshForBoot(
					abort.signal,
					() => {
						if (!cancelled) setPhase("retrying");
					},
					undefined,
					() => providersPromise.then((info) => info.bootRetry),
				),
			]);
			const providers = providersInfo.providers;
			if (cancelled || boot.kind === "cancelled") return;
			if (boot.kind === "unavailable") {
				setPhase("unavailable");
				return;
			}
			const tokens = boot.kind === "tokens" ? boot.tokens : null;
			if (!tokens) {
				if (cancelled) return;
				setState({
					signedIn: false,
					providers,
					principal: null,
					tokens: null,
					memberships: [],
					notice: null,
				});
				return;
			}
			const remembered = selectedAccountId();
			const knownNonToken = tokens.viaToken === false;
			const membershipsPromise = knownNonToken
				? readMemberships(tokens.accessToken)
				: Promise.resolve<SessionMembership[] | null>(null);
			const principalPromise = readPrincipal(tokens.accessToken, remembered);

			// When no remembered account override is active and refresh gave us the
			// home accountId, mount CadmusProvider immediately so whoami,
			// memberships, ws ticket, and first data loads run in parallel.
			const canMountEarly = !remembered && Boolean(tokens.accountId);
			if (canMountEarly) {
				setState({
					signedIn: true,
					providers,
					principal: null,
					tokens,
					memberships: [],
					notice: null,
				});
			}

			let membershipsSettled = false;
			let memberships: SessionMembership[] | null = null;
			void membershipsPromise.then((resolved) => {
				memberships = resolved;
				membershipsSettled = true;
			});
			let read = await principalPromise;
			if (cancelled) return;
			if (read.kind === "unavailable") {
				await new Promise((resolve) => setTimeout(resolve, 150));
				if (cancelled) return;
				read = await readPrincipal(tokens.accessToken, remembered);
				if (cancelled) return;
			}
			if (remembered && read.kind === "refused") {
				// The server refused the remembered account (membership removed,
				// account suspended): only then start on the home account, and
				// say so. A network error or 5xx keeps the choice and does not
				// switch accounts behind the user's back.
				selectAccount(null);
				const notice =
					"Your previous account is no longer available, so you are back in your own account.";
				read = await readPrincipal(tokens.accessToken);
				if (cancelled) return;
				if (read.kind === "unavailable") {
					await new Promise((resolve) => setTimeout(resolve, 150));
					if (cancelled) return;
					read = await readPrincipal(tokens.accessToken);
					if (cancelled) return;
				}
				if (read.kind === "unavailable") {
					setState(null);
					setPhase("unavailable");
					return;
				}
				const principal = read.kind === "ok" ? read.principal : null;
				const live = principal ? tokens : null;
				if (!membershipsSettled) {
					memberships = await membershipsPromise;
					if (cancelled) return;
				}
				if (
					live &&
					memberships === null &&
					principal?.kind === "user" &&
					!principal.viaToken
				) {
					memberships = await readMemberships(tokens.accessToken);
					if (cancelled) return;
				}
				setState({
					signedIn: live !== null,
					providers,
					principal: live ? principal : null,
					tokens: live,
					memberships: live ? (memberships ?? []) : [],
					notice: live ? notice : null,
				});
				return;
			}
			if (read.kind === "unavailable") {
				// A transient 5xx or network error checking whoami after refresh
				// succeeded is "unavailable", never signed-out fallback.
				setState(null);
				setPhase("unavailable");
				return;
			}
			const principal = read.kind === "ok" ? read.principal : null;
			const live = principal ? tokens : null;
			if (!membershipsSettled && canMountEarly && live) {
				// Publish principal right away so pages do not wait for memberships/list.
				setState({
					signedIn: true,
					providers,
					principal,
					tokens,
					memberships: [],
					notice: null,
				});
			}
			if (!membershipsSettled) {
				memberships = await membershipsPromise;
				if (cancelled) return;
			}
			if (
				live &&
				memberships === null &&
				principal?.kind === "user" &&
				!principal.viaToken
			) {
				memberships = await readMemberships(tokens.accessToken);
				if (cancelled) return;
			}
			setState({
				signedIn: live !== null,
				providers,
				principal: live ? principal : null,
				tokens: live,
				memberships: live ? (memberships ?? []) : [],
				notice: null,
			});
		})();
		cancelBoot.current = () => {
			cancelled = true;
			abort.abort();
		};
	}, []);
	useEffect(() => {
		startBoot();
		return () => cancelBoot.current?.();
	}, [startBoot]);
	if (!state && phase === "retrying") {
		return (
			<p role="status" className="p-6 text-sm text-muted-foreground">
				Reconnecting...
			</p>
		);
	}
	if (!state && phase === "unavailable") {
		return (
			<div role="alert" className="p-6 text-sm">
				<p>We could not check your sign-in just now.</p>
				<button
					type="button"
					className="mt-3 block whitespace-nowrap underline"
					onClick={() => startBoot()}
				>
					Try again
				</button>
			</div>
		);
	}
	if (!state) return null;
	return (
		<SessionContext.Provider value={state}>
			{children(state)}
		</SessionContext.Provider>
	);
}
