import { getLogger } from "./log.js";
import type {
	AdminStore,
	AuthenticatedIdentity,
} from "./store/admin-interface.js";
import type { Env } from "./types.js";

export interface ResolvedRequestScope extends AuthenticatedIdentity {
	familyId: string;
}

function extractRawToken(request: Request): string | undefined {
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
	let accountId: string | undefined;
	let userId: string | undefined;

	if (rawToken === masterSecret) {
		accountId =
			request.headers.get("x-account-id")?.trim() ||
			url.searchParams.get("accountId")?.trim() ||
			"default-account";
		userId =
			request.headers.get("x-user-id")?.trim() ||
			url.searchParams.get("userId")?.trim() ||
			`user:${accountId}`;
	} else {
		const parts = rawToken.split(":");
		if (parts.length === 2 && parts[1] === masterSecret && parts[0]) {
			accountId = parts[0];
			userId = request.headers.get("x-user-id")?.trim() || `user:${accountId}`;
		} else if (
			parts.length === 3 &&
			parts[2] === masterSecret &&
			parts[0] &&
			parts[1]
		) {
			accountId = parts[0];
			userId = parts[1];
		}
	}

	if (!accountId || !userId) {
		getLogger().warn("auth failed: invalid bearer token");
		return undefined;
	}

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
