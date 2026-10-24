import {
	type EdgeCache,
	getEdgeCache,
	isMasterUserEnsured,
	markMasterUserEnsured,
	sha256Hex,
} from "./edge-cache.js";
import { getLogger } from "./log.js";
import type {
	AdminStore,
	AuthenticatedIdentity,
} from "./store/admin-interface.js";
import type { Env } from "./types.js";

export interface ResolvedRequestScope extends AuthenticatedIdentity {
	familyId: string;
}

/**
 * Which credential transports `authenticateRequest` may read.
 *
 * Defaults accept the `Authorization` header, the `cadmus_session` cookie, and
 * `?token=`. `/api` passes `{ allowQueryToken: false, allowCookie: false }`
 * so only the header is a credential. `/rpc`, `/ws`, and `/events` keep the defaults.
 */
export interface AuthenticateRequestOptions {
	allowQueryToken?: boolean;
	allowCookie?: boolean;
}

export type AuthDenialCode =
	| "unauthorized"
	| "query_token_not_allowed"
	| "header_required";

export type AuthenticateRequestResult =
	| { ok: true; scope: ResolvedRequestScope }
	| { ok: false; code: AuthDenialCode; message: string };

const UNAUTHORIZED_MESSAGE = "Missing or invalid authentication token";
const QUERY_TOKEN_MESSAGE =
	"The token query parameter is not allowed. Send Authorization: Bearer instead.";
const HEADER_REQUIRED_MESSAGE =
	"Authorization: Bearer token is required. Session cookies are not accepted.";

function bearerToken(request: Request): string | undefined {
	const authHeader = request.headers.get("authorization");
	if (!authHeader) return undefined;
	const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
	const token = match?.[1]?.trim();
	return token ? token : undefined;
}

function sessionCookieToken(request: Request): string | undefined {
	const cookieHeader = request.headers.get("cookie");
	if (!cookieHeader) return undefined;
	for (const part of cookieHeader.split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === "cadmus_session" && rest.length > 0) {
			const value = decodeURIComponent(rest.join("=").trim());
			if (value.length > 0) return value;
		}
	}
	return undefined;
}

/**
 * True when the URL has a `token` query parameter.
 * The value is not read, so it cannot be logged from this check.
 */
export function hasQueryToken(request: Request): boolean {
	return new URL(request.url).searchParams.has("token");
}

export function extractRawToken(
	request: Request,
	options: AuthenticateRequestOptions = {},
): string | undefined {
	const headerToken = bearerToken(request);
	if (headerToken) return headerToken;
	if (options.allowCookie !== false) {
		const cookieToken = sessionCookieToken(request);
		if (cookieToken) return cookieToken;
	}
	if (options.allowQueryToken !== false) {
		const queryToken = new URL(request.url).searchParams.get("token")?.trim();
		if (queryToken) return queryToken;
	}
	return undefined;
}

export async function timingSafeEqualSha256(
	a: string,
	b: string,
): Promise<boolean> {
	const enc = new TextEncoder();
	const [digestA, digestB] = await Promise.all([
		crypto.subtle.digest("SHA-256", enc.encode(a)),
		crypto.subtle.digest("SHA-256", enc.encode(b)),
	]);
	const viewA = new Uint8Array(digestA);
	const viewB = new Uint8Array(digestB);
	let diff = 0;
	for (let i = 0; i < viewA.length; i++) {
		diff |= viewA[i] ^ viewB[i];
	}
	return diff === 0;
}

export interface MasterSecretMatch {
	matched: boolean;
	accountId?: string;
	userId?: string;
}

/**
 * Validates whether rawToken matches CADMUS_AUTH_SECRET in any accepted form:
 * 1. direct: <CADMUS_AUTH_SECRET>
 * 2. scoped account: <accountId>:<CADMUS_AUTH_SECRET>
 * 3. scoped account & user: <accountId>:<userId>:<CADMUS_AUTH_SECRET>
 *
 * Uses SHA-256 constant-time comparison to prevent timing/length side channels.
 */
export async function matchMasterSecret(
	rawToken: string,
	masterSecret: string,
): Promise<MasterSecretMatch> {
	if (await timingSafeEqualSha256(rawToken, masterSecret)) {
		return { matched: true };
	}

	const parts = rawToken.split(":");
	if (parts.length === 2 && parts[0]) {
		if (await timingSafeEqualSha256(parts[1], masterSecret)) {
			return { matched: true, accountId: parts[0] };
		}
	} else if (parts.length === 3 && parts[0] && parts[1]) {
		if (await timingSafeEqualSha256(parts[2], masterSecret)) {
			return { matched: true, accountId: parts[0], userId: parts[1] };
		}
	}

	return { matched: false };
}

/**
 * Authenticates every inbound HTTP / WebSocket request at the Worker Edge.
 * Anonymous and invalid credentials resolve as `{ ok: false, code: "unauthorized" }`
 * (401). `/api` may also deny with `query_token_not_allowed` or `header_required`.
 *
 * Supported token formats:
 * 1. Direct or scoped master secret (<CADMUS_AUTH_SECRET>) with constant-time check & isolate fast-path.
 * 2. Stored token in D1 `cadmus_auth_tokens` with L1 (memory) and optional L2 (KV) caching.
 *
 * `options.allowQueryToken` / `options.allowCookie` default to true. `/api` sets
 * both to false: a `token` query parameter is rejected before it is read, and a
 * session cookie is not a credential (`header_required` when it is the only one).
 */
export async function authenticateRequest(
	request: Request,
	env: Env,
	adminStore: AdminStore,
	edgeCache: EdgeCache = getEdgeCache(env),
	options: AuthenticateRequestOptions = {},
): Promise<AuthenticateRequestResult> {
	const allowQueryToken = options.allowQueryToken !== false;
	const allowCookie = options.allowCookie !== false;
	if (!allowQueryToken && hasQueryToken(request)) {
		const path = new URL(request.url).pathname;
		getLogger().warn("api credential transport rejected", {
			code: "query_token_not_allowed",
			method: request.method,
			path,
		});
		return {
			ok: false,
			code: "query_token_not_allowed",
			message: QUERY_TOKEN_MESSAGE,
		};
	}

	const rawToken = extractRawToken(request, {
		allowQueryToken,
		allowCookie,
	});
	if (!rawToken) {
		if (!allowCookie && sessionCookieToken(request)) {
			const path = new URL(request.url).pathname;
			getLogger().warn("api credential transport rejected", {
				code: "header_required",
				method: request.method,
				path,
			});
			return {
				ok: false,
				code: "header_required",
				message: HEADER_REQUIRED_MESSAGE,
			};
		}
		getLogger().debug("auth failed: no token present");
		return {
			ok: false,
			code: "unauthorized",
			message: UNAUTHORIZED_MESSAGE,
		};
	}

	const url = new URL(request.url);
	const requestedFamilyId =
		request.headers.get("x-cadmus-family-id")?.trim() ||
		request.headers.get("x-family-id")?.trim() ||
		url.searchParams.get("familyId")?.trim() ||
		"default";

	// 1. Master Secret Fast-Path: check before D1 queries using constant-time comparison
	const masterSecret = env.CADMUS_AUTH_SECRET || "dev-cadmus-secret";
	const masterMatch = await matchMasterSecret(rawToken, masterSecret);

	if (masterMatch.matched) {
		const accountId =
			masterMatch.accountId ||
			request.headers.get("x-account-id")?.trim() ||
			url.searchParams.get("accountId")?.trim() ||
			"default-account";
		const userId =
			masterMatch.userId ||
			request.headers.get("x-user-id")?.trim() ||
			url.searchParams.get("userId")?.trim() ||
			`user:${accountId}`;

		if (!isMasterUserEnsured(accountId, userId)) {
			await adminStore.ensureAccountAndUser({
				accountId,
				userId,
				role: "owner",
			});
			markMasterUserEnsured(accountId, userId);
		}
		edgeCache.recordMasterFastPath();
		getLogger().debug("authenticated via master secret (fast-path)", {
			account: accountId,
			user: userId,
			family: requestedFamilyId,
		});
		return {
			ok: true,
			scope: {
				accountId,
				userId,
				role: "owner",
				familyId: requestedFamilyId,
			},
		};
	}

	// 2. Check Edge Cache (L1 in-memory LRU + optional L2 KV) by token hash
	const tokenHash = await sha256Hex(rawToken);
	const cached = await edgeCache.getToken(tokenHash);
	if (cached) {
		getLogger().debug("authenticated via cached member token", {
			account: cached.accountId,
			user: cached.userId,
			family: requestedFamilyId,
		});
		return {
			ok: true,
			scope: {
				...cached,
				familyId: requestedFamilyId,
			},
		};
	}

	// 3. Cache miss: check stored token in D1 AdminStore
	const stored = await adminStore.resolveToken(rawToken);
	if (stored) {
		await edgeCache.setToken(tokenHash, stored);
		getLogger().debug("authenticated via D1 member token", {
			account: stored.accountId,
			user: stored.userId,
			family: requestedFamilyId,
		});
		return {
			ok: true,
			scope: {
				...stored,
				familyId: requestedFamilyId,
			},
		};
	}

	// Auth failed: invalid token (negative results are NOT cached)
	getLogger().warn("auth failed: invalid bearer token");
	return {
		ok: false,
		code: "unauthorized",
		message: UNAUTHORIZED_MESSAGE,
	};
}
