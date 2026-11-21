export interface SessionTokens {
	accessToken: string;
	expiresAt: number;
	sessionId?: string;
	accountId?: string;
	userId?: string;
	provisional?: boolean;
}

export interface SessionPrincipal {
	kind?: string;
	userId?: string;
	name?: string;
	email?: string;
	accountId: string;
	role: string;
	provisional?: boolean;
}

export interface SessionMembership {
	accountId: string;
	name: string;
	roles: string[];
}

export interface BootRetryConfig {
	waitMs?: number;
	retries?: number;
}

export interface ProvidersInfo {
	providers: string[];
	bootRetry?: BootRetryConfig;
}

export type BootRefresh =
	| { kind: "tokens"; tokens: SessionTokens }
	| { kind: "none" }
	| { kind: "unavailable" }
	| { kind: "cancelled" };

export type PrincipalRead =
	| { kind: "ok"; principal: SessionPrincipal }
	| { kind: "refused"; status: number }
	| { kind: "unavailable" };

const CSRF_HEADERS = { "X-Cadmus-Refresh": "1" } as const;
const BOOT_RETRY_MAX_MS = 10_000;
const BOOT_REFRESH_RETRIES = 3;
const BOOT_RETRY_DEFAULT_MS = 3_000;

interface RefreshOutcome {
	tokens: SessionTokens | null;
	transientMs: number | null;
}

let refreshInFlight: Promise<RefreshOutcome> | null = null;

function retryDelayMs(res: Response): number {
	const seconds = Number(res.headers.get("retry-after"));
	const ms =
		Number.isFinite(seconds) && seconds > 0
			? seconds * 1000
			: BOOT_RETRY_DEFAULT_MS;
	return Math.min(BOOT_RETRY_MAX_MS, Math.max(1_000, ms));
}

async function doRefresh(): Promise<RefreshOutcome> {
	try {
		const res = await fetch("/api/auth/session/refresh", {
			method: "POST",
			headers: CSRF_HEADERS,
			credentials: "same-origin",
		});
		if (!res.ok) {
			if (res.status === 429 || res.status >= 500) {
				return { tokens: null, transientMs: retryDelayMs(res) };
			}
			return { tokens: null, transientMs: null };
		}
		const body = (await res.json()) as {
			accessToken?: string;
			expiresAt?: number;
			sessionId?: string;
			accountId?: string;
			userId?: string;
			provisional?: boolean;
		};
		if (!body.accessToken || typeof body.expiresAt !== "number") {
			return { tokens: null, transientMs: null };
		}
		return {
			tokens: {
				accessToken: body.accessToken,
				expiresAt: body.expiresAt,
				sessionId: body.sessionId,
				accountId: body.accountId,
				userId: body.userId,
				...(body.provisional ? { provisional: true } : {}),
			},
			transientMs: null,
		};
	} catch {
		return { tokens: null, transientMs: BOOT_RETRY_DEFAULT_MS };
	}
}

function refreshOutcome(): Promise<RefreshOutcome> {
	if (refreshInFlight) return refreshInFlight;
	const locks = (
		globalThis.navigator as
			| {
					locks?: {
						request: <T>(name: string, cb: () => Promise<T>) => Promise<T>;
					};
			  }
			| undefined
	)?.locks;
	const run = locks
		? locks.request("cadmus-refresh", () => doRefresh())
		: doRefresh();
	refreshInFlight = run.finally(() => {
		refreshInFlight = null;
	});
	return refreshInFlight;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done);
	});
}

export async function fetchProvidersInfo(): Promise<ProvidersInfo> {
	try {
		const res = await fetch("/api/auth/login/providers", { cache: "no-store" });
		if (!res.ok) return { providers: [] };
		const body = (await res.json()) as {
			providers?: Array<{ id: string }>;
			bootRetry?: BootRetryConfig;
		};
		return {
			providers: (body.providers ?? []).map((provider) => provider.id),
			bootRetry: body.bootRetry,
		};
	} catch {
		return { providers: [] };
	}
}

export async function refreshForBoot(
	signal: AbortSignal,
	onRetry?: () => void,
	getRetryConfig?: () => Promise<BootRetryConfig | undefined>,
): Promise<BootRefresh> {
	let retryConfigLoaded = false;
	let retryConfig: BootRetryConfig | undefined;
	for (let attempt = 0; ; attempt++) {
		const { tokens, transientMs: delay } = await refreshOutcome();
		if (signal.aborted) return { kind: "cancelled" };
		if (tokens) return { kind: "tokens", tokens };
		if (delay === null) return { kind: "none" };
		if (!retryConfigLoaded) {
			retryConfigLoaded = true;
			retryConfig = getRetryConfig ? await getRetryConfig() : undefined;
			if (signal.aborted) return { kind: "cancelled" };
		}
		const maxRetries = retryConfig?.retries ?? BOOT_REFRESH_RETRIES;
		if (attempt >= maxRetries) return { kind: "unavailable" };
		const waitMs =
			retryConfig?.waitMs !== undefined
				? Math.min(delay, retryConfig.waitMs)
				: delay;
		onRetry?.();
		await abortableSleep(waitMs, signal);
		if (signal.aborted) return { kind: "cancelled" };
	}
}

export async function readPrincipal(
	accessToken: string,
): Promise<PrincipalRead> {
	try {
		const res = await fetch("/api/auth/whoami", {
			headers: { Authorization: `Bearer ${accessToken}` },
			cache: "no-store",
		});
		if (res.status === 401 || res.status === 403) {
			return { kind: "refused", status: res.status };
		}
		if (!res.ok) return { kind: "unavailable" };
		const body = (await res.json()) as {
			result?: { principal?: SessionPrincipal };
			principal?: SessionPrincipal;
		};
		const principal = body.result?.principal ?? body.principal;
		return principal ? { kind: "ok", principal } : { kind: "unavailable" };
	} catch {
		return { kind: "unavailable" };
	}
}

export async function readMemberships(
	accessToken: string,
): Promise<SessionMembership[]> {
	try {
		const res = await fetch("/api/auth/memberships/list", {
			headers: { Authorization: `Bearer ${accessToken}` },
			cache: "no-store",
		});
		if (!res.ok) return [];
		const body = (await res.json()) as {
			result?: { memberships?: SessionMembership[] };
			memberships?: SessionMembership[];
		};
		return body.result?.memberships ?? body.memberships ?? [];
	} catch {
		return [];
	}
}

const SELECTED_ACCOUNT_KEY = "cadmus-selected-account";

export function clearSelectedAccount(): void {
	try {
		sessionStorage.removeItem(SELECTED_ACCOUNT_KEY);
	} catch {
		// Storage unavailable.
	}
}

export async function signOut(accessToken?: string): Promise<void> {
	clearSelectedAccount();
	try {
		await fetch("/api/auth/session/logout", {
			method: "POST",
			headers: {
				...CSRF_HEADERS,
				...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
			},
			credentials: "same-origin",
		});
	} catch {
		// Best-effort sign-out before returning to stage 1.
	}
}
