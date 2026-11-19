import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useCadmus } from "@/context/CadmusContext";
import { useSession } from "@/context/SessionContext";
import { currentAccessToken, fetchPrincipal } from "@/lib/session";

/** "unknown" while checking, "unreadable" when the server could not be read. */
export type ElevationUntil = number | undefined | "unknown" | "unreadable";

export interface ElevationState {
	/** True when this session can use admin mode (an admin on a user session). */
	eligible: boolean;
	until: ElevationUntil;
	/** Wall clock that the countdown is measured against. */
	now: number;
	busy: boolean;
	error: string | null;
	/** Resolves true only when the server confirmed the change. */
	toggle: (on: boolean) => Promise<boolean>;
	refresh: () => Promise<boolean>;
	/** Clears an "unreadable" state and reads again. */
	recheck: () => void;
	/**
	 * True when the mode was last known to be on and the server has not since
	 * confirmed that it is off. The banner stays up while this holds.
	 */
	maybeOn: boolean;
}

const inert: ElevationState = {
	eligible: false,
	until: undefined,
	now: 0,
	busy: false,
	error: null,
	toggle: async () => false,
	refresh: async () => false,
	recheck: () => {},
	maybeOn: false,
};

const ElevationContext = createContext<ElevationState>(inert);

export function useElevation(): ElevationState {
	return useContext(ElevationContext);
}

/**
 * The one place that holds this session's admin-mode state, so the settings
 * control and the app-wide banner always agree. The server owns the state;
 * it is read on mount and on window focus and after any uncertain change.
 * Every read and write takes a ticket and only the newest may update the
 * state, so a slow earlier answer cannot overwrite a later result.
 */
export function ElevationProvider({ children }: { children: ReactNode }) {
	const session = useSession();
	const eligible =
		session.principal?.kind === "user" &&
		(session.principal.role === "account-admin" ||
			session.principal.role === "super-admin");
	return (
		<LiveElevation
			eligible={eligible}
			initialElevatedUntil={session.principal?.elevatedUntil}
		>
			{children}
		</LiveElevation>
	);
}

function LiveElevation({
	children,
	eligible,
	initialElevatedUntil,
}: {
	children: ReactNode;
	eligible: boolean;
	initialElevatedUntil?: number;
}) {
	const { client } = useCadmus();
	const [prevEligible, setPrevEligible] = useState(eligible);
	const [until, setUntil] = useState<ElevationUntil>(() =>
		eligible && initialElevatedUntil && initialElevatedUntil > Date.now()
			? initialElevatedUntil
			: undefined,
	);
	const [now, setNow] = useState(() => Date.now());
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ticket = useRef(0);
	// Set while the server last said On, cleared only when it says Off.
	const wasOn = useRef(false);
	if (prevEligible !== eligible) {
		setPrevEligible(eligible);
		const next =
			eligible && initialElevatedUntil && initialElevatedUntil > Date.now()
				? initialElevatedUntil
				: undefined;
		setUntil(next);
		setNow(Date.now());
		setBusy(false);
		setError(null);
	}
	if (eligible) {
		if (typeof until === "number") wasOn.current = true;
		else if (until === undefined) wasOn.current = false;
	} else {
		wasOn.current = false;
	}
	useEffect(() => {
		if (!eligible) {
			ticket.current += 1;
			return;
		}
		return () => {
			ticket.current += 1;
		};
	}, [eligible]);
	const maybeOn = eligible && (typeof until === "number" || wasOn.current);

	const refresh = useCallback(async () => {
		if (!eligible) return false;
		const mine = ++ticket.current;
		const token = currentAccessToken();
		const principal = token ? await fetchPrincipal(token.accessToken) : null;
		if (mine !== ticket.current) return false;
		if (!principal) {
			setUntil((prev) => (typeof prev === "number" ? prev : "unreadable"));
			return false;
		}
		const live = principal.elevatedUntil;
		setUntil(live && live > Date.now() ? live : undefined);
		setNow(Date.now());
		return true;
	}, [eligible]);

	useEffect(() => {
		if (!eligible) return;
		const onFocus = () => {
			void refresh();
		};
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [eligible, refresh]);

	useEffect(() => {
		if (!eligible || typeof until !== "number") return;
		const timer = setInterval(() => {
			const current = Date.now();
			setNow(current);
			if (current >= until) {
				// The deadline this tab knows may have been extended by another tab
				// on the same session, so only the server can say it is over. Stay
				// "maybe on" until it does.
				setUntil("unknown");
				void refresh();
			}
		}, 1000);
		return () => clearInterval(timer);
	}, [eligible, until, refresh]);

	const toggle = useCallback(
		async (on: boolean) => {
			setBusy(true);
			setError(null);
			ticket.current += 1;
			try {
				const res = on
					? await client.callRpc<{ elevatedUntil?: number }>("auth.elevate")
					: await client.callRpc("auth.elevation.end");
				if (!res.ok) {
					setError(res.error?.message ?? "That did not work");
					return false;
				}
				ticket.current += 1;
				if (on) {
					const next = (res.result as { elevatedUntil?: number } | undefined)
						?.elevatedUntil;
					setNow(Date.now());
					setUntil(next);
				} else {
					setUntil(undefined);
				}
				return true;
			} catch {
				// The request may or may not have reached the server.
				setError(
					"Could not confirm the change. Check the state and try again.",
				);
				setUntil("unknown");
				void refresh();
				return false;
			} finally {
				setBusy(false);
			}
		},
		[client, refresh],
	);

	const recheck = useCallback(() => {
		setUntil("unknown");
		void refresh();
	}, [refresh]);

	const value = useMemo<ElevationState>(
		() =>
			eligible
				? {
						eligible: true,
						until,
						now,
						busy,
						error,
						toggle,
						refresh,
						recheck,
						maybeOn,
					}
				: inert,
		[eligible, until, now, busy, error, toggle, refresh, recheck, maybeOn],
	);
	return (
		<ElevationContext.Provider value={value}>
			{children}
		</ElevationContext.Provider>
	);
}

export function formatRemaining(ms: number): string {
	const total = Math.max(0, Math.ceil(ms / 1000));
	const minutes = Math.floor(total / 60);
	const seconds = String(total % 60).padStart(2, "0");
	return `${minutes}:${seconds}`;
}
