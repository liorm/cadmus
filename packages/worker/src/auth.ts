import { SYSTEM_ACCOUNT_ID } from "@cadmus/contract/grants";
import {
	type EdgeCache,
	getEdgeCache,
	isMasterUserEnsured,
	markMasterUserEnsured,
	sha256Hex,
} from "./edge-cache.js";
import { getLogger } from "./log.js";
import { ProtocolValidationError } from "./protocol/validate.js";
import type {
	AdminStore,
	AuthenticatedIdentity,
} from "./store/admin-interface.js";
import {
	API_TOKEN_CACHE_TTL_SECONDS,
	API_TOKEN_CREDENTIAL_PREFIX,
} from "./store/api-token-credential.js";
import { apiTokenHash } from "./store/d1-tokens.js";
import type { Env } from "./types.js";

export interface ResolvedRequestScope extends AuthenticatedIdentity {
	familyId: string;
}

/**
 * Which credential transports `authenticateRequest` may read.
 *
 * Transport parsing still sees the header, the `cadmus_session` cookie and
 * `?token=`. `authenticateRequest` then refuses the cookie and `?token=` for
 * every credential, the master secret included. `/ws` and `/events` open with
 * a single-use ticket from `auth.ticket`. `/api` rejects the cookie and query
 * forms up front (`query_token_not_allowed`, `header_required`).
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

export function bearerToken(request: Request): string | undefined {
	const authHeader = request.headers.get("authorization");
	if (!authHeader) return undefined;
	const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
	const token = match?.[1]?.trim();
	return token ? token : undefined;
}

/**
 * One named cookie from the request `Cookie` header.
 *
 * `decode` is only for the retired `cadmus_session` credential, which clients
 * percent-encode. OAuth and refresh cookies are written raw and are returned
 * as written, including `""`. A decoded empty session value is treated as
 * missing. A malformed percent-escape is skipped (the next same-named cookie
 * can still match) so a bad `cadmus_session` is absent instead of throwing.
 */
export function readCookie(
	request: Request,
	name: string,
	options?: { decode?: boolean },
): string | undefined {
	const header = request.headers.get("cookie");
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key !== name) continue;
		const raw = rest.join("=");
		if (!options?.decode) return raw;
		if (rest.length === 0) continue;
		let value: string;
		try {
			value = decodeURIComponent(raw.trim());
		} catch (error) {
			if (error instanceof URIError) continue;
			throw error;
		}
		if (value.length > 0) return value;
	}
	return undefined;
}

function sessionCookieToken(request: Request): string | undefined {
	return readCookie(request, "cadmus_session", { decode: true });
}

/**
 * Refuses a cached `cad_pat_` / `cad_svc_` that is revoked, expired, or whose
 * user, account, or membership is no longer live. Service tokens and tokens
 * that carry elevated grants also write `token.use`. Any other credential
 * returns without a write.
 */
export async function requireLiveApiTokenUse(
	adminStore: Pick<AdminStore, "recordApiTokenUse">,
	identity: {
		credential?: string;
		userId?: string;
		accountId?: string;
	},
	use: string,
): Promise<void> {
	const { credential, userId, accountId } = identity;
	if (
		!credential?.startsWith(API_TOKEN_CREDENTIAL_PREFIX) ||
		!userId ||
		!accountId
	) {
		return;
	}
	const live = await adminStore.recordApiTokenUse({
		credential,
		userId,
		accountId,
		use,
	});
	if (!live) {
		throw new ProtocolValidationError(UNAUTHORIZED_MESSAGE, "unauthorized");
	}
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

	const ticketParam = new URL(request.url).searchParams.get("ticket");
	const ticketPath = new URL(request.url).pathname;
	if (ticketParam && (ticketPath === "/ws" || ticketPath === "/events")) {
		const target = ticketPath === "/events" ? "events" : "ws";
		const identity = await adminStore.consumeTicket(ticketParam, target);
		if (!identity) {
			return { ok: false, code: "unauthorized", message: UNAUTHORIZED_MESSAGE };
		}
		const familyParam =
			request.headers.get("x-cadmus-family-id")?.trim() ||
			new URL(request.url).searchParams.get("familyId")?.trim() ||
			"default";
		try {
			await requireLiveApiTokenUse(adminStore, identity, `stream:${target}`);
		} catch (error) {
			if (error instanceof ProtocolValidationError) {
				return {
					ok: false,
					code: "unauthorized",
					message: UNAUTHORIZED_MESSAGE,
				};
			}
			throw error;
		}
		return {
			ok: true,
			scope: {
				accountId: identity.accountId,
				userId: identity.userId,
				role: identity.role,
				...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
				...(identity.grants ? { grants: identity.grants } : {}),
				...(!identity.sessionId && identity.credential
					? { credential: identity.credential }
					: {}),
				familyId: familyParam,
			},
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

	// Credential transport. Issue #3 phases 3 and 8 retire `?token=` and the
	// `cadmus_session` cookie as credentials: every credential, the master
	// secret included, is accepted from the header only. Streams open with a
	// ticket that a header-authenticated `auth.ticket` call minted.
	const transport: "header" | "cookie" | "query" = bearerToken(request)
		? "header"
		: sessionCookieToken(request)
			? "cookie"
			: "query";
	const rejectTransport = (): AuthenticateRequestResult => {
		getLogger().warn("credential transport rejected", {
			transport,
			method: request.method,
			path: url.pathname,
		});
		return { ok: false, code: "unauthorized", message: UNAUTHORIZED_MESSAGE };
	};

	// 1. Master Secret Fast-Path: check before D1 queries using constant-time comparison
	const masterSecret = env.CADMUS_AUTH_SECRET?.trim() ?? "";
	const masterMatch = masterSecret
		? await matchMasterSecret(rawToken, masterSecret)
		: { matched: false };

	if (masterMatch.matched) {
		if (transport !== "header") return rejectTransport();
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

		if (accountId === SYSTEM_ACCOUNT_ID) {
			return {
				ok: false,
				code: "unauthorized",
				message: `Account id '${SYSTEM_ACCOUNT_ID}' is reserved`,
			};
		}

		if (!isMasterUserEnsured(accountId, userId)) {
			await adminStore.ensureAccountAndUser({
				accountId,
				userId,
				role: "account-admin",
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
				role: "account-admin",
				credential: "master",
				familyId: requestedFamilyId,
			},
		};
	}

	// Every other credential (legacy member tokens, session tokens, API tokens)
	// is header-only.
	if (transport !== "header") return rejectTransport();

	// `cad_pat_`, `cad_svc_` and `cad_at_` are bearers on /api and /rpc. Streams
	// open with a single-use ticket (`?ticket=`, handled above). Legacy member
	// tokens stay header credentials on /ws and /events.
	const issuedToken =
		rawToken.startsWith("cad_pat_") ||
		rawToken.startsWith("cad_svc_") ||
		rawToken.startsWith("cad_at_");
	if (issuedToken && (url.pathname === "/ws" || url.pathname === "/events")) {
		getLogger().warn("stream credential rejected: ticket required", {
			method: request.method,
			path: url.pathname,
		});
		return {
			ok: false,
			code: "unauthorized",
			message: UNAUTHORIZED_MESSAGE,
		};
	}

	// API tokens (`cad_pat_` / `cad_svc_`). The resolved scope is cached for about
	// 60s; revoke drops it in this isolate immediately. Every service-token (and
	// elevated-token) command is audited as `token.use`.
	if (rawToken.startsWith("cad_pat_") || rawToken.startsWith("cad_svc_")) {
		const hintedAccount =
			request.headers.get("x-account-id")?.trim() ||
			url.searchParams.get("accountId")?.trim() ||
			undefined;
		const tokenHash = await apiTokenHash(rawToken);
		const generation = edgeCache.tokenGeneration;
		let identity = await edgeCache.getToken(tokenHash);
		if (!identity) {
			const resolved = await adminStore.resolveApiToken(rawToken);
			if (!resolved) {
				return {
					ok: false,
					code: "unauthorized",
					message: UNAUTHORIZED_MESSAGE,
				};
			}
			identity = resolved;
			await edgeCache.setToken(
				tokenHash,
				resolved,
				API_TOKEN_CACHE_TTL_SECONDS,
				generation,
			);
		}
		if (hintedAccount && hintedAccount !== identity.accountId) {
			return {
				ok: false,
				code: "unauthorized",
				message: UNAUTHORIZED_MESSAGE,
			};
		}
		return {
			ok: true,
			scope: {
				accountId: identity.accountId,
				userId: identity.userId,
				role: identity.role,
				...(identity.grants ? { grants: identity.grants } : {}),
				...(identity.credential ? { credential: identity.credential } : {}),
				familyId: requestedFamilyId,
			},
		};
	}

	// 1b. Cadmus-issued session access tokens (never cached: D1 is the source of
	// truth, so revocation and suspension take effect immediately).
	if (rawToken.startsWith("cad_at_")) {
		// `x-account-id` selects among the user's own memberships. The store
		// re-checks the live membership, so a foreign or unknown id fails the
		// same way a bad token does.
		const selected = request.headers.get("x-account-id")?.trim() || undefined;
		const session = await adminStore.resolveAccessToken(rawToken, selected);
		if (!session) {
			return { ok: false, code: "unauthorized", message: UNAUTHORIZED_MESSAGE };
		}
		return {
			ok: true,
			scope: {
				accountId: session.accountId,
				userId: session.userId,
				role: session.role,
				sessionId: session.sessionId,
				...(session.grants ? { grants: session.grants } : {}),
				...(session.elevatedUntil
					? { elevatedUntil: session.elevatedUntil }
					: {}),
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
				credential: `member-token:${tokenHash}`,
				familyId: requestedFamilyId,
			},
		};
	}

	// 3. Cache miss: check stored token in D1 AdminStore
	const generation = edgeCache.tokenGeneration;
	const stored = await adminStore.resolveToken(rawToken);
	if (stored) {
		await edgeCache.setToken(tokenHash, stored, undefined, generation);
		getLogger().debug("authenticated via D1 member token", {
			account: stored.accountId,
			user: stored.userId,
			family: requestedFamilyId,
		});
		return {
			ok: true,
			scope: {
				...stored,
				credential: `member-token:${tokenHash}`,
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
