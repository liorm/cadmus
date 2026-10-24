import { getLogger } from "./log.js";
import type {
	AdminStore,
	AuthenticatedIdentity,
} from "./store/admin-interface.js";
import type { Env } from "./types.js";

export interface ResolvedRequestScope extends AuthenticatedIdentity {
	familyId: string;
}

export function extractRawToken(request: Request): string | undefined {
	const authHeader = request.headers.get("authorization");
	if (authHeader) {
		const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
		if (match?.[1]) return match[1].trim();
	}
	const cookieHeader = request.headers.get("cookie");
	if (cookieHeader) {
		for (const part of cookieHeader.split(";")) {
			const [key, ...rest] = part.trim().split("=");
			if (key === "cadmus_session" && rest.length > 0) {
				return decodeURIComponent(rest.join("=").trim());
			}
		}
	}
	const url = new URL(request.url);
	const queryToken = url.searchParams.get("token");
	if (queryToken) return queryToken.trim();
	return undefined;
}

async function timingSafeEqualSha256(a: string, b: string): Promise<boolean> {
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
 * Anonymous requests are rejected with undefined (401 Unauthorized).
 *
 * Supported token formats:
 * 1. Stored token in D1 `cadmus_auth_tokens` (resolved via `adminStore.resolveToken`).
 * 2. Scoped master token: `<accountId>:<userId>:<CADMUS_AUTH_SECRET>` or `<accountId>:<CADMUS_AUTH_SECRET>`.
 * 3. Direct master secret (`<CADMUS_AUTH_SECRET>`) with optional `x-account-id` / `x-user-id` headers.
 */
export async function authenticateRequest(
	request: Request,
	env: Env,
	adminStore: AdminStore,
): Promise<ResolvedRequestScope | undefined> {
	const rawToken = extractRawToken(request);
	if (!rawToken) {
		getLogger().debug("auth failed: no token present");
		return undefined;
	}

	const url = new URL(request.url);
	const requestedFamilyId =
		request.headers.get("x-cadmus-family-id")?.trim() ||
		request.headers.get("x-family-id")?.trim() ||
		url.searchParams.get("familyId")?.trim() ||
		"default";

	// 1. Check stored token in D1 AdminStore
	const stored = await adminStore.resolveToken(rawToken);
	if (stored) {
		getLogger().debug("authenticated via D1 member token", {
			account: stored.accountId,
			user: stored.userId,
			family: requestedFamilyId,
		});
		return {
			...stored,
			familyId: requestedFamilyId,
		};
	}

	// 2. Check against CADMUS_AUTH_SECRET
	const masterSecret = env.CADMUS_AUTH_SECRET || "dev-cadmus-secret";
	const masterMatch = await matchMasterSecret(rawToken, masterSecret);
	if (!masterMatch.matched) {
		getLogger().warn("auth failed: invalid bearer token");
		return undefined;
	}

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

	await adminStore.ensureAccountAndUser({
		accountId,
		userId,
		role: "owner",
	});

	getLogger().debug("authenticated via master secret", {
		account: accountId,
		user: userId,
		family: requestedFamilyId,
	});

	return {
		accountId,
		userId,
		role: "owner",
		familyId: requestedFamilyId,
	};
}
