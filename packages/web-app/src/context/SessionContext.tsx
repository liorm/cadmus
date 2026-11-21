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
	buildLoginRedirectUrl,
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
	/** True when a full (non-provisional) Cadmus session is active. */
	signedIn: boolean;
	principal: SessionPrincipal | null;
	tokens: SessionTokens | null;
	memberships: SessionMembership[];
	/** One line shown once when the app had to leave a remembered account. */
	notice?: string | null;
}

const SessionContext = createContext<SessionState>({
	signedIn: false,
	principal: null,
	tokens: null,
	memberships: [],
});

export function useSession(): SessionState {
	return useContext(SessionContext);
}

function redirectToLogin(): void {
	if (typeof window === "undefined") return;
	window.location.replace(
		buildLoginRedirectUrl(window.location.pathname, window.location.search),
	);
}

/**
 * Resolves the session once at boot inside `/app`.
 *
 * Unauthenticated or provisional sessions are redirected immediately to
 * `/login` before the main app bundle is loaded or rendered.
 */
export function SessionBoot({
	children,
}: {
	children: (state: SessionState) => ReactNode;
}) {
	const [state, setState] = useState<SessionState | null>(null);
	const [phase, setPhase] = useState<
		"loading" | "retrying" | "unavailable" | "redirecting"
	>("loading");
	const cancelBoot = useRef<(() => void) | null>(null);

	const startBoot = useCallback(() => {
		cancelBoot.current?.();
		let cancelled = false;
		const abort = new AbortController();
		setPhase("loading");
		void (async () => {
			let retryConfigPromise: Promise<
				Awaited<ReturnType<typeof fetchProvidersInfo>>["bootRetry"]
			> | null = null;
			const boot = await refreshForBoot(
				abort.signal,
				() => {
					if (!cancelled) setPhase("retrying");
				},
				undefined,
				() => {
					retryConfigPromise ??= fetchProvidersInfo().then(
						(info) => info.bootRetry,
					);
					return retryConfigPromise;
				},
			);
			if (cancelled || boot.kind === "cancelled") return;
			if (boot.kind === "unavailable") {
				setPhase("unavailable");
				return;
			}
			const tokens = boot.kind === "tokens" ? boot.tokens : null;
			if (!tokens || tokens.provisional) {
				if (cancelled) return;
				setState(null);
				setPhase("redirecting");
				redirectToLogin();
				return;
			}

			const remembered = selectedAccountId();
			const membershipsPromise = readMemberships(tokens.accessToken);
			const principalPromise = readPrincipal(tokens.accessToken, remembered);

			const canMountEarly = !remembered && Boolean(tokens.accountId);
			if (canMountEarly) {
				setState({
					signedIn: true,
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
				if (!principal || principal.provisional) {
					setState(null);
					setPhase("redirecting");
					redirectToLogin();
					return;
				}
				if (!membershipsSettled) {
					memberships = await membershipsPromise;
					if (cancelled) return;
				}
				if (memberships === null && principal.kind === "user") {
					memberships = await readMemberships(tokens.accessToken);
					if (cancelled) return;
				}
				setState({
					signedIn: true,
					principal,
					tokens,
					memberships: memberships ?? [],
					notice,
				});
				return;
			}
			if (read.kind === "unavailable") {
				setState(null);
				setPhase("unavailable");
				return;
			}
			const principal = read.kind === "ok" ? read.principal : null;
			if (!principal || principal.provisional) {
				setState(null);
				setPhase("redirecting");
				redirectToLogin();
				return;
			}
			if (!membershipsSettled && canMountEarly) {
				setState({
					signedIn: true,
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
			if (memberships === null && principal.kind === "user") {
				memberships = await readMemberships(tokens.accessToken);
				if (cancelled) return;
			}
			setState({
				signedIn: true,
				principal,
				tokens,
				memberships: memberships ?? [],
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
