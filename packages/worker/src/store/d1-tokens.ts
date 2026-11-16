import {
	GRANTS,
	type Grant,
	grantsForRole,
	isGrant,
	normalizeRole,
	type Role,
} from "@cadmus/contract/grants";
import { sha256Hex } from "../edge-cache.js";
import {
	apiTokenCredential,
	apiTokenHashFromCredential,
} from "./api-token-credential.js";
import { randomId, randomToken } from "./random-id.js";

/**
 * API tokens (`cad_pat_`, `cad_svc_`) are stored under a domain-separated hash.
 * Bearer authentication looks them up by that hash. A Worker from before API
 * tokens looks every bearer up as `sha256(raw)` and returns the member's full
 * role, ignoring revoked_at, expires_at and grants. The separated hash keeps
 * these rows from matching that lookup, so a rollback cannot accept a revoked,
 * expired or narrowed API token.
 */
export const API_TOKEN_HASH_DOMAIN = "cadmus-api-token-v1:";
export function apiTokenHash(raw: string): Promise<string> {
	return sha256Hex(`${API_TOKEN_HASH_DOMAIN}${raw}`);
}

import {
	clampTokenGrants,
	createSession,
	type SessionTokens,
} from "./d1-sessions.js";

/** Issue #3 phase 4: server-generated API tokens (cad_pat_ / cad_svc_). */
export const PAT_PREFIX = "cad_pat_";
export const SERVICE_PREFIX = "cad_svc_";
export const SERVICE_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SERVICE_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PAT_MAX_TTL_MS = 365 * 24 * 60 * 60 * 1000;

export type TokenKind = "pat" | "service";

export interface TokenSummary {
	id: string;
	kind: TokenKind;
	label: string;
	grants: Grant[];
	createdBy: string | null;
	createdAt: number;
	expiresAt: number | null;
	lastUsedAt: number | null;
	revokedAt: number | null;
	elevated: boolean;
}

export type CreateTokenResult =
	| { ok: true; token: string; summary: TokenSummary }
	| {
			ok: false;
			code: "invalid" | "forbidden";
			message: string;
	  };

export interface CreateTokenInput {
	accountId: string;
	creatorUserId: string;
	creatorRole: Role;
	/** Grants the creator holds right now; the new token is a subset. */
	creatorGrants: readonly Grant[];
	kind: TokenKind;
	label: string;
	grants?: readonly string[];
	ttlMs?: number;
	/**
	 * The creating user session, when it is in admin mode for `accountId` right
	 * now. Only then may the token carry elevated grants (decision 13).
	 */
	elevatedBySessionId?: string;
	now?: number;
}

/** A token that carries elevated grants lives at most this long. */
export const ELEVATED_TOKEN_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function parseGrants(raw: string | null): Grant[] {
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter(isGrant) : [];
	} catch {
		return [];
	}
}

/** Stored role names (including the pre-#3 ones) whose grants include all of `grants`. */
function roleNamesHolding(grants: readonly Grant[]): string[] {
	const names: Array<[string, Role]> = [
		["user", "user"],
		["member", "user"],
		["account-admin", "account-admin"],
		["owner", "account-admin"],
		["super-admin", "super-admin"],
	];
	return names
		.filter(([, role]) =>
			grants.every((grant) => grantsForRole(role).includes(grant)),
		)
		.map(([name]) => name);
}

/**
 * Creates a token. Grants are an explicit subset of the creator's current
 * grants (never above). A grant flagged elevation is stored only when the
 * creator is in admin mode, and that token is capped at 30 days. Service
 * tokens expire within 30 days. A non-elevated personal token must name an
 * expiry.
 */
export async function createToken(
	db: D1Database,
	input: CreateTokenInput,
): Promise<CreateTokenResult> {
	const now = input.now ?? Date.now();
	const label = input.label.trim();
	if (!label || label.length > 80) {
		return { ok: false, code: "invalid", message: "label must be 1-80 chars" };
	}
	const requested = input.grants ?? [];
	if (requested.length === 0) {
		return {
			ok: false,
			code: "invalid",
			message: "grants must list at least one grant",
		};
	}
	const grants: Grant[] = [];
	let carriesElevated = false;
	for (const name of requested) {
		if (!isGrant(name)) {
			return { ok: false, code: "invalid", message: `unknown grant ${name}` };
		}
		if (!input.creatorGrants.includes(name)) {
			return {
				ok: false,
				code: "forbidden",
				message: `grant ${name} is above the creator's grants`,
			};
		}
		if (GRANTS[name].scope === "system" && input.accountId !== "system") {
			return {
				ok: false,
				code: "forbidden",
				message: `grant ${name} is not available in this account`,
			};
		}
		if (GRANTS[name].elevation) {
			if (input.elevatedBySessionId) {
				carriesElevated = true;
			} else {
				return {
					ok: false,
					code: "forbidden",
					message: `grant ${name} needs admin mode`,
				};
			}
		}
		if (!grants.includes(name)) grants.push(name);
	}
	const maxTtl = carriesElevated
		? ELEVATED_TOKEN_MAX_TTL_MS
		: input.kind === "service"
			? SERVICE_MAX_TTL_MS
			: PAT_MAX_TTL_MS;
	// Service tokens default to 7 days. An elevated personal token that omits
	// an expiry gets the 30-day cap. A non-elevated personal token must name one.
	const ttl =
		input.ttlMs ??
		(input.kind === "service"
			? SERVICE_DEFAULT_TTL_MS
			: carriesElevated
				? ELEVATED_TOKEN_MAX_TTL_MS
				: null);
	if (ttl === null) {
		return {
			ok: false,
			code: "invalid",
			message: "Personal tokens require an expiry",
		};
	}
	if (!Number.isFinite(ttl) || ttl <= 0 || ttl > maxTtl) {
		return {
			ok: false,
			code: "invalid",
			message: `expiry must be within ${Math.floor(maxTtl / 86_400_000)} days`,
		};
	}
	const raw = randomToken(
		input.kind === "service" ? SERVICE_PREFIX : PAT_PREFIX,
	);
	const id = randomId("tok_");
	const expiresAt = now + ttl;
	// The creator's authority is checked again inside the INSERT: the caller's
	// grant snapshot can be stale (a demotion may have landed since), so the row
	// is only written while the creator's current role still holds every grant.
	const roles = roleNamesHolding(grants);
	const marks = roles.map((_, i) => `?${i + 10}`).join(", ");
	const results = await db.batch([
		db
			.prepare(
				`INSERT INTO cadmus_auth_tokens
           (token_hash, user_id, account_id, label, created_at, id, kind, grants, created_by, elevated, expires_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?2, ${carriesElevated ? 1 : 0}, ?9
          WHERE EXISTS (SELECT 1 FROM cadmus_account_members
                         WHERE account_id = ?3 AND user_id = ?2 AND role IN (${marks || "''"}))
            AND (${carriesElevated ? "0" : "1"} = 1 OR EXISTS (
                  SELECT 1 FROM cadmus_sessions
                   WHERE id = ?${10 + roles.length} AND user_id = ?2 AND token_id IS NULL
                     AND revoked_at IS NULL AND elevated_until > ?5
                     AND COALESCE(elevated_account_id, account_id) = ?3))`,
			)
			.bind(
				await apiTokenHash(raw),
				input.creatorUserId,
				input.accountId,
				label,
				now,
				id,
				input.kind,
				JSON.stringify(grants),
				expiresAt,
				...roles,
				input.elevatedBySessionId ?? "",
			),
		db
			.prepare(
				`INSERT INTO cadmus_audit (id, account_id, actor_user_id, actor_kind, action, target_account_id, target, data, at)
         SELECT ?1, ?2, ?3, 'user', 'token.create', ?2, ?4, ?5, ?6
          WHERE EXISTS (SELECT 1 FROM cadmus_auth_tokens WHERE id = ?4)`,
			)
			.bind(
				randomId("aud_"),
				input.accountId,
				input.creatorUserId,
				id,
				JSON.stringify({
					kind: input.kind,
					grants,
					expiresAt,
					...(carriesElevated ? { elevated: true } : {}),
				}),
				now,
			),
	]);
	if ((results[0]?.meta?.changes ?? 0) === 0) {
		return {
			ok: false,
			code: "forbidden",
			message: carriesElevated
				? "the creator no longer holds these grants or is no longer in admin mode"
				: "the creator no longer holds these grants",
		};
	}
	return {
		ok: true,
		token: raw,
		summary: {
			id,
			kind: input.kind,
			label,
			grants,
			createdBy: input.creatorUserId,
			createdAt: now,
			expiresAt,
			lastUsedAt: null,
			revokedAt: null,
			elevated: carriesElevated,
		},
	};
}

interface TokenRow {
	id: string;
	kind: string;
	label: string | null;
	grants: string | null;
	created_by: string | null;
	created_at: number;
	expires_at: number | null;
	last_used_at: number | null;
	revoked_at: number | null;
	elevated: number;
}

function toSummary(row: TokenRow): TokenSummary {
	return {
		id: row.id,
		kind: row.kind === "service" ? "service" : "pat",
		label: row.label ?? "",
		grants: parseGrants(row.grants),
		createdBy: row.created_by,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		lastUsedAt: row.last_used_at,
		revokedAt: row.revoked_at,
		elevated: row.elevated === 1,
	};
}

/** Lists tokens in an account: own tokens, or every token when `all`. */
export async function listTokens(
	db: D1Database,
	accountId: string,
	userId: string,
	all: boolean,
): Promise<TokenSummary[]> {
	const res = await db
		.prepare(
			`SELECT id, kind, label, grants, created_by, created_at, expires_at, last_used_at, revoked_at, elevated
         FROM cadmus_auth_tokens
        WHERE account_id = ?1 AND (?3 = 1 OR user_id = ?2)
        ORDER BY created_at DESC LIMIT 200`,
		)
		.bind(accountId, userId, all ? 1 : 0)
		.all<TokenRow>();
	return (res.results ?? []).map(toSummary);
}

/**
 * Revokes a token and every session started from it. Returns false when the
 * token is not in the account, is not the caller's (unless `all`), or was
 * already revoked.
 *
 * One D1 batch (one transaction): the token UPDATE, its audit row and the
 * session revocation commit together or not at all. The audit row is written
 * directly after the UPDATE and only when `changes() > 0`, so a concurrent
 * revoke that lost the race writes none. The sessions UPDATE is fenced on this
 * operation's own audit row (fixed id), so a loser never touches sessions.
 */
export async function revokeTokenById(
	db: D1Database,
	input: {
		accountId: string;
		userId: string;
		tokenId: string;
		all: boolean;
		now?: number;
	},
): Promise<boolean> {
	const now = input.now ?? Date.now();
	const auditId = randomId("aud_");
	const results = await db.batch([
		db
			.prepare(
				`UPDATE cadmus_auth_tokens SET revoked_at = ?4
        WHERE id = ?1 AND account_id = ?2 AND revoked_at IS NULL
          AND (?5 = 1 OR user_id = ?3)`,
			)
			.bind(
				input.tokenId,
				input.accountId,
				input.userId,
				now,
				input.all ? 1 : 0,
			),
		// Directly after the UPDATE, so changes() is this operation's own result.
		db
			.prepare(
				`INSERT INTO cadmus_audit (id, account_id, actor_user_id, actor_kind, action, target_account_id, target, data, at)
         SELECT ?1, ?2, ?3, 'user', 'token.revoke', ?2, ?4, '{}', ?5
          WHERE changes() > 0`,
			)
			.bind(auditId, input.accountId, input.userId, input.tokenId, now),
		db
			.prepare(
				`UPDATE cadmus_sessions SET revoked_at = ?2
          WHERE token_id = ?1 AND revoked_at IS NULL
            AND EXISTS (SELECT 1 FROM cadmus_audit WHERE id = ?3)`,
			)
			.bind(input.tokenId, now, auditId),
	]);
	return (results[0]?.meta?.changes ?? 0) > 0;
}

export type TokenLoginResult =
	| { ok: true; tokens: SessionTokens; accountId: string; userId: string }
	| { ok: false };

/**
 * POST /auth/token-login core: exchanges a live cad_pat_/cad_svc_ token for a
 * normal session bound to the token's account. The session role is the token
 * owner's membership role; its grants are clamped to the token's at request
 * time (see tokenGrantsForSession).
 */
export async function tokenLogin(
	db: D1Database,
	rawToken: string,
	meta: { userAgent?: string; ipCountry?: string },
	now = Date.now(),
): Promise<TokenLoginResult> {
	if (
		!rawToken.startsWith(PAT_PREFIX) &&
		!rawToken.startsWith(SERVICE_PREFIX)
	) {
		return { ok: false };
	}
	const row = await db
		.prepare(
			`SELECT t.id, t.user_id, t.account_id, t.expires_at, m.role, u.disabled_at
         FROM cadmus_auth_tokens t
         JOIN cadmus_account_members m
           ON m.account_id = t.account_id AND m.user_id = t.user_id
         JOIN cadmus_users u ON u.id = t.user_id
         JOIN cadmus_accounts a ON a.id = t.account_id AND a.status = 'active'
        WHERE t.token_hash = ?1 AND t.revoked_at IS NULL
          AND (t.expires_at IS NULL OR t.expires_at > ?2)`,
		)
		.bind(await apiTokenHash(rawToken), now)
		.first<{
			id: string;
			user_id: string;
			account_id: string;
			expires_at: number | null;
			role: string;
			disabled_at: number | null;
		}>();
	if (!row || row.disabled_at || !normalizeRole(row.role)) return { ok: false };
	const tokens = await createSession(db, {
		userId: row.user_id,
		accountId: row.account_id,
		tokenId: row.id,
		userAgent: meta.userAgent,
		ipCountry: meta.ipCountry,
		now,
	});
	await db.batch([
		db
			.prepare(`UPDATE cadmus_auth_tokens SET last_used_at = ?2 WHERE id = ?1`)
			.bind(row.id, now),
		db
			.prepare(
				`INSERT INTO cadmus_audit (id, account_id, actor_user_id, actor_kind, action, target_account_id, target, data, at)
         VALUES (?1, ?2, ?3, 'token', 'token.login', ?2, ?4, ?5, ?6)`,
			)
			.bind(
				`aud_${tokens.sessionId.slice(4)}_l`,
				row.account_id,
				row.user_id,
				row.id,
				JSON.stringify({ sessionId: tokens.sessionId }),
				now,
			),
	]);
	return { ok: true, tokens, accountId: row.account_id, userId: row.user_id };
}

export interface ResolvedApiToken {
	userId: string;
	accountId: string;
	role: Role;
	grants: Grant[];
	credential: string;
}

/**
 * Resolves a raw `cad_pat_` / `cad_svc_` bearer to the token owner's live
 * membership. Grants are the stored set clamped to the current role. The
 * credential names the domain-separated hash so a later socket re-read and
 * the use-audit can find the same row. Returns undefined when the token is
 * unknown, revoked, expired, or its user or account is not active.
 */
export async function resolveApiToken(
	db: D1Database,
	rawToken: string,
	now = Date.now(),
): Promise<ResolvedApiToken | undefined> {
	if (
		!rawToken.startsWith(PAT_PREFIX) &&
		!rawToken.startsWith(SERVICE_PREFIX)
	) {
		return undefined;
	}
	const hash = await apiTokenHash(rawToken);
	const row = await db
		.prepare(
			`SELECT t.user_id, t.account_id, t.grants, m.role
         FROM cadmus_auth_tokens t
         JOIN cadmus_account_members m
           ON m.account_id = t.account_id AND m.user_id = t.user_id
         JOIN cadmus_users u ON u.id = t.user_id AND u.disabled_at IS NULL
         JOIN cadmus_accounts a ON a.id = t.account_id AND a.status = 'active'
        WHERE t.token_hash = ?1 AND t.revoked_at IS NULL
          AND (t.expires_at IS NULL OR t.expires_at > ?2)`,
		)
		.bind(hash, now)
		.first<{
			user_id: string;
			account_id: string;
			grants: string | null;
			role: string;
		}>();
	if (!row) return undefined;
	const role = normalizeRole(row.role);
	if (!role) return undefined;
	return {
		userId: row.user_id,
		accountId: row.account_id,
		role,
		grants: clampTokenGrants(row.grants, role),
		credential: apiTokenCredential(hash),
	};
}

/**
 * Records one use of an API token and refreshes `last_used_at`.
 * A service token, and any token that carries elevated grants, also writes a
 * `token.use` audit row (decisions 10 and 13). The write re-checks the
 * membership, the user (`disabled_at`), and the account (`status = active`),
 * because the edge may still be serving a scope cached before that changed.
 * A revoked, expired, or no-longer-live token writes nothing and returns false
 * so the caller can refuse the request.
 */
export async function recordApiTokenUse(
	db: D1Database,
	input: {
		credential: string;
		userId: string;
		accountId: string;
		use: string;
		now?: number;
	},
): Promise<boolean> {
	const hash = apiTokenHashFromCredential(input.credential);
	if (!hash) return false;
	const now = input.now ?? Date.now();
	const auditId = randomId("aud_");
	const results = await db.batch([
		db
			.prepare(
				`UPDATE cadmus_auth_tokens SET last_used_at = ?4
        WHERE token_hash = ?1 AND user_id = ?2 AND account_id = ?3
          AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?4)
          AND EXISTS (SELECT 1 FROM cadmus_account_members m
                       WHERE m.account_id = ?3 AND m.user_id = ?2)
          AND EXISTS (SELECT 1 FROM cadmus_users u
                       WHERE u.id = ?2 AND u.disabled_at IS NULL)
          AND EXISTS (SELECT 1 FROM cadmus_accounts a
                       WHERE a.id = ?3 AND a.status = 'active')`,
			)
			.bind(hash, input.userId, input.accountId, now),
		db
			.prepare(
				`INSERT INTO cadmus_audit (id, account_id, actor_user_id, actor_kind, action, target_account_id, target, data, at)
         SELECT ?1, ?2, ?3, 'token', 'token.use', ?2, id, ?5, ?4
           FROM cadmus_auth_tokens
          WHERE token_hash = ?6 AND user_id = ?3 AND account_id = ?2
            AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?4)
            AND EXISTS (SELECT 1 FROM cadmus_account_members m
                        WHERE m.account_id = ?2 AND m.user_id = ?3)
            AND EXISTS (SELECT 1 FROM cadmus_users u
                        WHERE u.id = ?3 AND u.disabled_at IS NULL)
            AND EXISTS (SELECT 1 FROM cadmus_accounts a
                        WHERE a.id = ?2 AND a.status = 'active')
            AND (kind = 'service' OR elevated = 1)
            AND changes() > 0`,
			)
			.bind(
				auditId,
				input.accountId,
				input.userId,
				now,
				JSON.stringify({ use: input.use }),
				hash,
			),
	]);
	return (results[0]?.meta?.changes ?? 0) > 0;
}
