/**
 * Cadmus session helpers (issue #3). The access token lives in memory only;
 * the refresh token is an HttpOnly cookie that only POST /auth/refresh reads.
 */

export interface SessionTokens {
	accessToken: string;
	expiresAt: number;
	/** The session this token belongs to; tabs only share tokens of one session. */
	sessionId?: string;
	accountId?: string;
	userId?: string;
	viaToken?: boolean;
}

export interface SessionPrincipal {
	kind?: string;
	/** True when an API token opened this session; it cannot enter admin mode. */
	viaToken?: boolean;
	userId?: string;
	accountId: string;
	role: string;
	/** Epoch ms when admin mode ends. Absent when it is off. */
	elevatedUntil?: number;
}

/** Refresh this long before the access token expires. */
export const REFRESH_MARGIN_MS = 60_000;

const CSRF_HEADERS = { "X-Cadmus-Refresh": "1" } as const;

export interface BootRetryConfig {
	waitMs?: number;
	retries?: number;
}

export interface ProvidersInfo {
	providers: string[];
	bootRetry?: BootRetryConfig;
}

export async function fetchProvidersInfo(): Promise<ProvidersInfo> {
	try {
		const res = await fetch("/auth/providers", { cache: "no-store" });
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

export async function fetchProviders(): Promise<string[]> {
	return (await fetchProvidersInfo()).providers;
}

/**
 * One refresh attempt's result. `transientMs` is set only when it failed in a
 * way that may pass (429, 5xx, network error): the suggested wait, capped. The
 * outcome travels with the shared in-flight promise, so a caller can never read
 * another caller's result.
 */
interface RefreshOutcome {
	tokens: SessionTokens | null;
	transientMs: number | null;
}

let refreshInFlight: Promise<RefreshOutcome> | null = null;

/**
 * The newest access token this browser knows, in memory only. Tabs share it
 * over a same-origin BroadcastChannel: each refresh rotates the session's single
 * access token, so a tab that refreshed must hand the new one to the others or
 * it would silently invalidate theirs.
 */
let latest: SessionTokens | null = null;
/**
 * The session this page signed in as. Unlike \`latest\` it survives refresh
 * refusals and expired tokens: only a confirmed sign-out clears it, so a later
 * refresh can never swap in a different sign-in that took over the shared
 * cookie. A refused tab stays bound and needs a reload to sign in again.
 */
let bound: string | undefined;
const listeners = new Set<(tokens: SessionTokens) => void>();
const endListeners = new Set<() => void>();
const channel: BroadcastChannel | null =
	typeof BroadcastChannel === "undefined"
		? null
		: new BroadcastChannel("cadmus-session");

function adopt(tokens: SessionTokens, announce: boolean): void {
	if (latest && latest.expiresAt >= tokens.expiresAt) return;
	latest = tokens;
	if (tokens.sessionId) bound ??= tokens.sessionId;
	for (const listener of listeners) listener(tokens);
	if (announce) channel?.postMessage({ kind: "tokens", ...tokens });
}

if (channel) {
	channel.onmessage = (event: MessageEvent) => {
		const data = event.data as
			| (Partial<SessionTokens> & { kind?: string })
			| null;
		// Only act for the session this tab already holds. A tab signed in as
		// someone else, or not signed in, never takes another tab's credential.
		if (!bound || data?.sessionId !== bound) return;
		if (data.kind === "signout") {
			latest = null;
			bound = undefined;
			for (const listener of endListeners) listener();
			return;
		}
		if (data.accessToken && typeof data.expiresAt === "number") {
			adopt(
				{
					accessToken: data.accessToken,
					expiresAt: data.expiresAt,
					sessionId: data.sessionId,
				},
				false,
			);
		}
	};
}

/** Called when another tab (or this one) obtains a newer access token. */
export function onSessionTokens(
	listener: (tokens: SessionTokens) => void,
): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Called when another tab signs this session out. */
export function onSessionEnded(listener: () => void): () => void {
	endListeners.add(listener);
	return () => endListeners.delete(listener);
}

/** The best access token we hold, used for logout and similar calls. */
export function currentAccessToken(): SessionTokens | null {
	return latest;
}

/**
 * Exchanges the refresh cookie for a new access token, or null. Refreshes
 * rotate the cookie, and presenting an already-rotated token revokes the whole
 * session, so concurrent callers share one request in this page (React
 * StrictMode mounts twice) and a Web Lock serializes tabs of the same browser.
 */
export async function refreshSession(
	force = false,
): Promise<SessionTokens | null> {
	return (await refreshOutcome(force)).tokens;
}

function refreshOutcome(force: boolean): Promise<RefreshOutcome> {
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
		? locks.request("cadmus-refresh", () => doRefresh(force))
		: doRefresh(force);
	refreshInFlight = run.finally(() => {
		refreshInFlight = null;
	});
	return refreshInFlight;
}

/** Longest wait between boot refresh attempts, whatever Retry-After says. */
export const BOOT_RETRY_MAX_MS = 10_000;
/** Retries after the first boot refresh (so at most 1 + this many requests). */
export const BOOT_REFRESH_RETRIES = 3;
const BOOT_RETRY_DEFAULT_MS = 3_000;

function retryDelayMs(res: Response): number {
	const seconds = Number(res.headers.get("retry-after"));
	const ms =
		Number.isFinite(seconds) && seconds > 0
			? seconds * 1000
			: BOOT_RETRY_DEFAULT_MS;
	return Math.min(BOOT_RETRY_MAX_MS, Math.max(1_000, ms));
}

async function doRefresh(force: boolean): Promise<RefreshOutcome> {
	const done = (tokens: SessionTokens | null): RefreshOutcome => ({
		tokens,
		transientMs: null,
	});
	// Another tab may have refreshed while we waited for the lock.
	if (
		!force &&
		latest &&
		latest.expiresAt - Date.now() > REFRESH_MARGIN_MS * 2
	) {
		return done(latest);
	}
	try {
		const res = await fetch("/auth/refresh", {
			method: "POST",
			headers: CSRF_HEADERS,
			credentials: "same-origin",
		});
		if (!res.ok) {
			if (res.status === 401) latest = null;
			else if (res.status === 429 || res.status >= 500) {
				return { tokens: null, transientMs: retryDelayMs(res) };
			}
			return done(null);
		}
		const body = (await res.json()) as {
			accessToken?: string;
			expiresAt?: number;
			sessionId?: string;
			accountId?: string;
			userId?: string;
			viaToken?: boolean;
		};
		if (!body.accessToken || typeof body.expiresAt !== "number")
			return done(null);
		const next: SessionTokens = {
			accessToken: body.accessToken,
			expiresAt: body.expiresAt,
			sessionId: body.sessionId,
			...(body.accountId ? { accountId: body.accountId } : {}),
			...(body.userId ? { userId: body.userId } : {}),
			...(typeof body.viaToken === "boolean"
				? { viaToken: body.viaToken }
				: {}),
		};
		if (bound && next.sessionId !== bound) {
			// The browser's cookie now belongs to another sign-in. This tab keeps
			// its own identity (never installs it) and just passes the rotated
			// credential on to the tab that owns that session.
			if (next.sessionId) channel?.postMessage({ kind: "tokens", ...next });
			return done(null);
		}
		// A forced refresh replaces the shared token even if it expires no later.
		if (force) latest = null;
		adopt(next, true);
		return done(next);
	} catch {
		return { tokens: null, transientMs: BOOT_RETRY_DEFAULT_MS };
	}
}

export type BootRefresh =
	| { kind: "tokens"; tokens: SessionTokens }
	/** No session: no cookie, or the server refused it (401). */
	| { kind: "none" }
	/** Still rate limited or unreachable after the bounded retries. */
	| { kind: "unavailable" }
	| { kind: "cancelled" };

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

/**
 * The first refresh of a page load. A transient failure (429, 5xx, network)
 * is not "signed out": it is retried a few times, waiting what Retry-After
 * says but never more than BOOT_RETRY_MAX_MS, and the caller learns of each
 * wait through onRetry. A 401 or a missing session ends at once as "none".
 * Aborting stops the waiting and sends no further request.
 */
export async function refreshForBoot(
	signal: AbortSignal,
	onRetry?: () => void,
	sleep: (ms: number, signal: AbortSignal) => Promise<void> = abortableSleep,
	getRetryConfig?: () => Promise<BootRetryConfig | undefined>,
): Promise<BootRefresh> {
	let retryConfigLoaded = false;
	let retryConfig: BootRetryConfig | undefined;
	for (let attempt = 0; ; attempt++) {
		const { tokens, transientMs: delay } = await refreshOutcome(false);
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
		await sleep(waitMs, signal);
		if (signal.aborted) return { kind: "cancelled" };
	}
}

/**
 * Ends the session on the server and reports whether it is really over. The
 * refresh cookie only reaches /auth/refresh, so logout authenticates with the
 * access token. A 200 alone is not proof (a stale bearer revokes nothing), so
 * the body's `revoked` flag decides; on a stale bearer the session is repaired
 * with a forced refresh and logout is retried. Without a confirmed revoke
 * (refused refresh, missing cookie, network error) the result is false.
 */
export async function signOut(): Promise<boolean> {
	const attempt = async (token: string): Promise<boolean> => {
		try {
			const res = await fetch("/auth/logout", {
				method: "POST",
				headers: { ...CSRF_HEADERS, Authorization: `Bearer ${token}` },
				credentials: "same-origin",
			});
			if (!res.ok) return false;
			const body = (await res.json()) as { revoked?: boolean };
			return body.revoked === true;
		} catch {
			return false;
		}
	};
	const sessionId = bound ?? latest?.sessionId;
	const finish = async (): Promise<boolean> => {
		// The refresh cookie may still be set. Presenting it is the one way to
		// clear it, and the server clears it only when its session is gone. If it
		// belongs to a different sign-in, that sign-in is left alone.
		await refreshSession(true);
		latest = null;
		bound = undefined;
		if (sessionId) channel?.postMessage({ kind: "signout", sessionId });
		return true;
	};
	const known = currentAccessToken();
	if (known && (await attempt(known.accessToken))) return finish();
	const fresh = await refreshSession(true);
	if (fresh) return (await attempt(fresh.accessToken)) ? finish() : false;
	// No revoke was confirmed. A missing or foreign cookie says nothing about
	// this session, so report failure rather than claim it ended.
	return false;
}

const ACCOUNT_KEY = "cadmus-selected-account";

/**
 * The account this tab acts in, when it chose one other than its own. It lives
 * in sessionStorage so each tab keeps its own choice and a new tab starts on the
 * session's home account. The server re-checks the membership on every request.
 */
export function selectedAccountId(): string | undefined {
	try {
		return window.sessionStorage.getItem(ACCOUNT_KEY)?.trim() || undefined;
	} catch {
		return undefined;
	}
}

export function selectAccount(accountId: string | null): void {
	try {
		if (accountId) window.sessionStorage.setItem(ACCOUNT_KEY, accountId);
		else window.sessionStorage.removeItem(ACCOUNT_KEY);
	} catch {
		// Storage unavailable: the tab stays on its home account.
	}
}

export type PrincipalRead =
	| { kind: "ok"; principal: SessionPrincipal }
	| { kind: "refused"; status: number }
	| { kind: "unavailable" };

/**
 * Reads the principal and says why it could not. Only a 401 or 403 means the
 * server refused this token or account; a network error, a 5xx or an
 * unreadable body is "unavailable" and must never be taken as a refusal.
 */
export async function readPrincipal(
	accessToken: string,
	accountId: string | undefined = selectedAccountId(),
): Promise<PrincipalRead> {
	try {
		const res = await fetch("/api/auth/whoami", {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				...(accountId ? { "x-account-id": accountId } : {}),
			},
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

export async function fetchPrincipal(
	accessToken: string,
	accountId: string | undefined = selectedAccountId(),
): Promise<SessionPrincipal | null> {
	const read = await readPrincipal(accessToken, accountId);
	return read.kind === "ok" ? read.principal : null;
}

export interface SessionMembership {
	accountId: string;
	name: string;
	role: string;
	status: string;
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

export function isoTime(ms: number): string {
	return new Date(ms).toLocaleString();
}
