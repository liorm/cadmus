import {
	isRole,
	normalizeRole,
	type Role,
	SYSTEM_ACCOUNT_ID,
} from "@cadmus/contract/grants";
import type { Credential } from "@earendil-works/pi-ai";
import type { LoginIdentity } from "../auth/google.js";
import { type EdgeCache, sha256Hex } from "../edge-cache.js";
import { getLogger } from "../log.js";
import type {
	AccountMember,
	ConfinementPolicy,
	CredentialInput,
	CredentialSummary,
	FamilyRecord,
	ToolsEnvBinding,
} from "../protocol.js";
import type {
	AccountRecord,
	AdminStore,
	FamilySettingsPatch,
	StoredToolsEnv,
} from "./admin-interface.js";
import {
	approveDeviceLogin,
	type DeviceDecisionResult,
	type DeviceLoginStart,
	type DevicePollResult,
	denyDeviceLogin,
	pollDeviceLogin,
	startDeviceLogin,
} from "./d1-device-login.js";
import { completeLogin, type LoginResult } from "./d1-login.js";
import {
	inviteMember,
	listInvites,
	removeMember,
	revokeInvite,
	updateMemberRole,
} from "./d1-members.js";
import {
	assumeStoredRole,
	auditElevatedCommand,
	type CreateSessionInput,
	consumeTicket,
	createSession,
	createTicket,
	type ElevatedCommandPhase,
	type ElevatedOperation,
	endElevation,
	listLoginMethods,
	listMemberships,
	listSessions,
	type RefreshResult,
	resolveAccessToken,
	resolveSessionById,
	revokeLoginMethod,
	revokeOtherSessions,
	revokeOwnSession,
	revokeSession,
	revokeSessionByRefresh,
	rotateRefreshToken,
	type SessionIdentity,
	type SessionTokens,
	sessionRefusalReason,
	startElevation,
	type TicketTarget,
} from "./d1-sessions.js";
import {
	accountCreateAudit,
	cleanName,
	listAccountAudit,
	listAccountMembers,
	listSystemAccounts,
	listSystemAudit,
	renameAccount,
	revokeUserSessions,
	type SystemAccount,
	type SystemAuditEvent,
	type SystemResult,
	setAccountStatus,
	setUserDisabled,
} from "./d1-system.js";
import { parseStoredRoles } from "./roles.js";
import {
	insertPrimaryUserStatements,
	normalizeLoginEmail,
	userProfile,
} from "./user-emails.js";

/** Creates the bootstrap super-admin once, with a primary email and no login method. */
export async function seedBootstrapSuperAdmin(
	db: D1Database,
	rawEmail: string | undefined,
): Promise<void> {
	const email = rawEmail ? normalizeLoginEmail(rawEmail) : "";
	if (!email) return;
	const claimed = await db
		.prepare(`SELECT 1 AS x FROM cadmus_bootstrap WHERE id = 1`)
		.first<{ x: number }>();
	if (claimed) return;
	const now = Date.now();
	const user = insertPrimaryUserStatements(db, email, email, now);
	await db.batch([
		...user.statements,
		db
			.prepare(
				`INSERT INTO cadmus_account_members (account_id, user_id, created_at)
         SELECT '${SYSTEM_ACCOUNT_ID}', e.user_id, ?2
         FROM cadmus_user_emails e
         WHERE e.email = ?1
           AND NOT EXISTS (
             SELECT 1 FROM cadmus_account_members m
             WHERE m.account_id = '${SYSTEM_ACCOUNT_ID}' AND m.user_id = e.user_id
           )`,
			)
			.bind(email, now),
		db
			.prepare(
				`INSERT OR IGNORE INTO cadmus_member_roles (account_id, user_id, role, created_at)
         SELECT '${SYSTEM_ACCOUNT_ID}', e.user_id, 'super-admin', ?2
         FROM cadmus_user_emails e WHERE e.email = ?1`,
			)
			.bind(email, now),
		db
			.prepare(
				`INSERT INTO cadmus_bootstrap (id, claimed_at, user_id)
         SELECT 1, ?2, e.user_id FROM cadmus_user_emails e
         WHERE e.email = ?1
           AND NOT EXISTS (SELECT 1 FROM cadmus_bootstrap WHERE id = 1)`,
			)
			.bind(email, now),
	]);
}

/**
 * Development only. The bootstrap user also holds user and account-admin on
 * tenant `dev`, so local login can choose a hat. Idempotent after bootstrap.
 */
export async function seedDevTenantRoles(
	db: D1Database,
	rawEmail: string | undefined,
): Promise<void> {
	const email = rawEmail ? normalizeLoginEmail(rawEmail) : "";
	if (!email) return;
	const now = Date.now();
	await db.batch([
		db
			.prepare(
				`INSERT OR IGNORE INTO cadmus_accounts (id, name, timezone, created_at, parent_account_id, status)
         VALUES ('dev', 'Dev', 'UTC', ?1, '${SYSTEM_ACCOUNT_ID}', 'active')`,
			)
			.bind(now),
		db
			.prepare(
				`INSERT OR IGNORE INTO cadmus_account_members (account_id, user_id, created_at)
         SELECT 'dev', e.user_id, ?2 FROM cadmus_user_emails e WHERE e.email = ?1`,
			)
			.bind(email, now),
		db
			.prepare(
				`INSERT OR IGNORE INTO cadmus_member_roles (account_id, user_id, role, created_at)
         SELECT 'dev', e.user_id, 'user', ?2 FROM cadmus_user_emails e WHERE e.email = ?1`,
			)
			.bind(email, now),
		db
			.prepare(
				`INSERT OR IGNORE INTO cadmus_member_roles (account_id, user_id, role, created_at)
         SELECT 'dev', e.user_id, 'account-admin', ?2 FROM cadmus_user_emails e WHERE e.email = ?1`,
			)
			.bind(email, now),
	]);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toDoName(accountId: string, familyId: string): string {
	return `cadmus:${accountId}:${familyId}`;
}

export { sha256Hex };

const aesKeyCache = new Map<string, CryptoKey>();

export function clearAesKeyCache(): void {
	aesKeyCache.clear();
}

async function deriveAesKey(
	masterSecret: string,
	accountId: string,
): Promise<CryptoKey> {
	const cacheKey = `${masterSecret}:${accountId}`;
	const existing = aesKeyCache.get(cacheKey);
	if (existing) return existing;

	const keyMaterial = await crypto.subtle.digest(
		"SHA-256",
		encoder.encode(`cadmus-byok-v1:${masterSecret}:${accountId}`),
	);
	const key = await crypto.subtle.importKey(
		"raw",
		keyMaterial,
		{ name: "AES-GCM" },
		false,
		["encrypt", "decrypt"],
	);
	aesKeyCache.set(cacheKey, key);
	return key;
}

async function encryptJson(
	masterSecret: string,
	accountId: string,
	value: unknown,
): Promise<{ ivHex: string; cipherHex: string }> {
	const key = await deriveAesKey(masterSecret, accountId);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const plaintext = encoder.encode(JSON.stringify(value));
	const encrypted = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		key,
		plaintext,
	);
	return {
		ivHex: toHex(iv),
		cipherHex: toHex(new Uint8Array(encrypted)),
	};
}

async function decryptJson<T>(
	masterSecret: string,
	accountId: string,
	ivHex: string,
	cipherHex: string,
): Promise<T> {
	const key = await deriveAesKey(masterSecret, accountId);
	const iv = fromHex(ivHex);
	const ciphertext = fromHex(cipherHex);
	const decrypted = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: iv as BufferSource },
		key,
		ciphertext as BufferSource,
	);
	return JSON.parse(decoder.decode(decrypted)) as T;
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function fromHex(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
}

function normalizeCredential(input: CredentialInput | Credential): Credential {
	if (input.type === "api_key") {
		const key = "apiKey" in input ? input.apiKey : input.key;
		return { type: "api_key", key };
	}
	const raw = input as {
		accessToken?: unknown;
		access?: unknown;
		refreshToken?: unknown;
		refresh?: unknown;
		expiresAt?: unknown;
		expires?: unknown;
	};
	const access =
		typeof raw.accessToken === "string"
			? raw.accessToken
			: typeof raw.access === "string"
				? raw.access
				: "";
	const refresh =
		typeof raw.refreshToken === "string"
			? raw.refreshToken
			: typeof raw.refresh === "string"
				? raw.refresh
				: "";
	const expires =
		typeof raw.expiresAt === "number"
			? raw.expiresAt
			: typeof raw.expires === "number"
				? raw.expires
				: Date.now() + 3600_000;
	return {
		type: "oauth",
		access,
		refresh,
		expires,
	};
}

function slugifyId(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48) || "default"
	);
}

export const CADMUS_SCHEMA_VERSION = 17;

export function isMissingSchemaError(error: unknown): boolean {
	if (!error) return false;
	const msg =
		typeof error === "string"
			? error
			: (error as { message?: string }).message || String(error);
	return /no such (table|column):/i.test(msg);
}

export interface D1InitStats {
	schemaChecks: number;
	migrationsRun: number;
}

const d1InitStats: D1InitStats = {
	schemaChecks: 0,
	migrationsRun: 0,
};

export function getD1InitStats(): D1InitStats {
	return { ...d1InitStats };
}

export function resetD1InitStats(): void {
	d1InitStats.schemaChecks = 0;
	d1InitStats.migrationsRun = 0;
}

interface InFlightInit {
	promise: Promise<void>;
	forced: boolean;
}

const initializedDbs = new Set<D1Database>();
const inFlightInits = new Map<D1Database, InFlightInit>();

export function isD1DatabaseInitialized(db: D1Database): boolean {
	return initializedDbs.has(db);
}

export function resetD1InitializationCache(db?: D1Database): void {
	if (db) {
		initializedDbs.delete(db);
		inFlightInits.delete(db);
	} else {
		initializedDbs.clear();
		inFlightInits.clear();
	}
}

export async function readSchemaVersion(
	db: D1Database,
): Promise<number | null> {
	d1InitStats.schemaChecks++;
	try {
		const row = await db
			.prepare("SELECT value FROM cadmus_schema_meta WHERE key = 'version'")
			.first<{ value: string }>();
		if (!row?.value) return null;
		const parsed = Number.parseInt(row.value, 10);
		return Number.isNaN(parsed) ? null : parsed;
	} catch (error) {
		if (isMissingSchemaError(error)) {
			return null;
		}
		throw error;
	}
}

function seedJustBashStatement(
	db: D1Database,
	accountId: string,
	now: number,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT OR IGNORE INTO cadmus_tools_envs (
          account_id, env_id, kind, label, workspace_path, persist,
          confine_to_workspace, confinement_policy, shared_workspace, updated_at
        ) VALUES (?1, 'jb_default', 'just-bash', 'Default just-bash', NULL, 1, 1, 'required', 0, ?2)`,
		)
		.bind(accountId, now);
}

async function seedJustBashDefault(
	db: D1Database,
	accountId: string,
	now: number,
): Promise<void> {
	await seedJustBashStatement(db, accountId, now).run();
}

export async function runD1SchemaMigrations(db: D1Database): Promise<void> {
	d1InitStats.migrationsRun++;
	await db.batch([
		db.prepare(`
        CREATE TABLE IF NOT EXISTS cadmus_accounts (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          timezone TEXT NOT NULL DEFAULT 'UTC',
          created_at INTEGER NOT NULL
        )
      `),
		db.prepare(`
        CREATE TABLE IF NOT EXISTS cadmus_users (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT,
          created_at INTEGER NOT NULL
        )
      `),
		db.prepare(`
        CREATE TABLE IF NOT EXISTS cadmus_account_members (
          account_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          role TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (account_id, user_id)
        )
      `),
		db.prepare(`
        CREATE TABLE IF NOT EXISTS cadmus_auth_tokens (
          token_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          label TEXT,
          created_at INTEGER NOT NULL
        )
      `),
		db.prepare(`
        CREATE TABLE IF NOT EXISTS cadmus_account_credentials (
          account_id TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          cred_type TEXT NOT NULL,
          iv_hex TEXT NOT NULL,
          cipher_hex TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (account_id, provider_id)
        )
      `),
		db.prepare(`
        CREATE TABLE IF NOT EXISTS cadmus_families (
          account_id TEXT NOT NULL,
          family_id TEXT NOT NULL,
          name TEXT NOT NULL,
          do_name TEXT NOT NULL,
          timezone TEXT NOT NULL,
          harvest_delay_ms INTEGER NOT NULL,
          team_leader_bot_id TEXT,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (account_id, family_id)
        )
      `),
		db.prepare(`
        CREATE TABLE IF NOT EXISTS cadmus_tools_envs (
          account_id TEXT NOT NULL,
          env_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          label TEXT,
          workspace_path TEXT,
          persist INTEGER NOT NULL DEFAULT 1,
          confine_to_workspace INTEGER NOT NULL DEFAULT 1,
          confinement_policy TEXT NOT NULL DEFAULT 'required',
          shared_workspace INTEGER NOT NULL DEFAULT 0,
          daemon_token_hash TEXT,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (account_id, env_id)
        )
      `),
		db.prepare(`
        CREATE TABLE IF NOT EXISTS cadmus_schema_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `),
	]);

	await addColumnIfNotExists(
		db,
		"cadmus_accounts",
		"timezone",
		"TEXT NOT NULL DEFAULT 'UTC'",
	);
	await addColumnIfNotExists(
		db,
		"cadmus_families",
		"team_leader_bot_id",
		"TEXT",
	);
	await addColumnIfNotExists(
		db,
		"cadmus_tools_envs",
		"confinement_policy",
		"TEXT NOT NULL DEFAULT 'required'",
	);

	await migrateToolsEnvCredentialColumns(db);

	const addedDefaultToolsEnv = await addColumnIfNotExists(
		db,
		"cadmus_accounts",
		"default_tools_env_json",
		"TEXT",
	);
	if (addedDefaultToolsEnv) {
		const accounts = await db
			.prepare(`SELECT id FROM cadmus_accounts`)
			.all<{ id: string }>();
		const now = Date.now();
		for (const account of accounts.results) {
			await seedJustBashDefault(db, account.id, now);
			await db
				.prepare(
					`UPDATE cadmus_accounts
             SET default_tools_env_json = ?1
             WHERE id = ?2 AND default_tools_env_json IS NULL`,
				)
				.bind(JSON.stringify({ envId: "jb_default" }), account.id)
				.run();
		}
	}

	await migrateRolesAndAccounts(db);
	await migrateSessionsSchema(db);
	await migrateMemberRoles(db);
	await dropApiTokens(db);
	// Phase 7: verified Google auth_time (epoch ms) for a fresh-sign-in session.
	await addColumnIfNotExists(
		db,
		"cadmus_sessions",
		"fresh_google_at",
		"INTEGER",
	);
	await db
		.prepare(
			`INSERT INTO cadmus_schema_meta (key, value)
       VALUES ('version', ?1)
       ON CONFLICT(key) DO UPDATE SET value = ?1`,
		)
		.bind(String(CADMUS_SCHEMA_VERSION))
		.run();
}

/**
 * Issue #3 phase 2. Idempotent and non-destructive:
 * - accounts gain `parent_account_id` (every tenant defaults to the system
 *   account; the CHECK allows a NULL parent only for the system account),
 *   `status` and `suspended_at`;
 * - the one built-in system account is seeded;
 * - roles are renamed owner -> account-admin and member -> user;
 * - the audit table is created.
 */
async function migrateRolesAndAccounts(db: D1Database): Promise<void> {
	await addColumnIfNotExists(
		db,
		"cadmus_accounts",
		"parent_account_id",
		`TEXT DEFAULT '${SYSTEM_ACCOUNT_ID}' CHECK ((id = '${SYSTEM_ACCOUNT_ID}') = (parent_account_id IS NULL))`,
	);
	await addColumnIfNotExists(
		db,
		"cadmus_accounts",
		"status",
		"TEXT NOT NULL DEFAULT 'active'",
	);
	await addColumnIfNotExists(db, "cadmus_accounts", "suspended_at", "INTEGER");
	const memberCols = await db
		.prepare(`PRAGMA table_info(cadmus_account_members)`)
		.all<{ name: string }>();
	const hasRole = memberCols.results.some((c) => c.name === "role");
	await db.batch([
		db
			.prepare(
				`INSERT OR IGNORE INTO cadmus_accounts
           (id, name, timezone, created_at, parent_account_id, status)
         VALUES (?1, 'System', 'UTC', ?2, NULL, 'active')`,
			)
			.bind(SYSTEM_ACCOUNT_ID, Date.now()),
		...(hasRole
			? [
					db.prepare(
						`UPDATE cadmus_account_members SET role = 'account-admin' WHERE role = 'owner'`,
					),
					db.prepare(
						`UPDATE cadmus_account_members SET role = 'user' WHERE role = 'member'`,
					),
				]
			: []),
		db.prepare(`
        CREATE TABLE IF NOT EXISTS cadmus_audit (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          actor_user_id TEXT,
          actor_kind TEXT NOT NULL,
          action TEXT NOT NULL,
          target_account_id TEXT,
          target TEXT,
          data TEXT,
          at INTEGER NOT NULL
        )
      `),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_cadmus_audit_account_at ON cadmus_audit(account_id, at)`,
		),
	]);
}

/**
 * Issue #104. Revoke sessions that were opened from an API token, then drop
 * `cadmus_auth_tokens`. A token-login session must not keep working as a user
 * session after the table is gone. Fresh databases create the table in
 * `runD1SchemaMigrations` and drop it here, once, when the schema version moves.
 */
async function dropApiTokens(db: D1Database): Promise<void> {
	const now = Date.now();
	// DROP IF EXISTS so two isolates migrating the same database do not fail
	// when the other already removed the table between the check and the drop.
	await db.batch([
		db
			.prepare(
				`UPDATE cadmus_sessions SET revoked_at = ?1
         WHERE token_id IS NOT NULL AND revoked_at IS NULL`,
			)
			.bind(now),
		db.prepare(`DROP TABLE IF EXISTS cadmus_auth_tokens`),
	]);
}

/**
 * Issue #3 phase 3a. Idempotent. Adds the user identity columns, the token
 * metadata columns (legacy tokens become `pat` rows labelled legacy), and the
 * invite, login method, session and bootstrap tables. `dropApiTokens` removes
 * the token table after this runs.
 */
async function migrateSessionsSchema(db: D1Database): Promise<void> {
	await addColumnIfNotExists(db, "cadmus_users", "primary_email", "TEXT");
	await addColumnIfNotExists(db, "cadmus_users", "disabled_at", "INTEGER");
	await addColumnIfNotExists(db, "cadmus_auth_tokens", "id", "TEXT");
	await addColumnIfNotExists(
		db,
		"cadmus_auth_tokens",
		"kind",
		"TEXT NOT NULL DEFAULT 'pat'",
	);
	await addColumnIfNotExists(db, "cadmus_auth_tokens", "grants", "TEXT");
	await addColumnIfNotExists(db, "cadmus_auth_tokens", "created_by", "TEXT");
	await addColumnIfNotExists(
		db,
		"cadmus_auth_tokens",
		"elevated",
		"INTEGER NOT NULL DEFAULT 0",
	);
	await addColumnIfNotExists(db, "cadmus_auth_tokens", "expires_at", "INTEGER");
	await addColumnIfNotExists(
		db,
		"cadmus_auth_tokens",
		"last_used_at",
		"INTEGER",
	);
	await addColumnIfNotExists(db, "cadmus_auth_tokens", "revoked_at", "INTEGER");
	const tokenTable = await db
		.prepare(
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cadmus_auth_tokens'`,
		)
		.first<{ name: string }>();
	if (tokenTable) {
		try {
			await db.batch([
				db.prepare(
					`UPDATE cadmus_auth_tokens
         SET id = 'tok_' || lower(hex(randomblob(8)))
       WHERE id IS NULL`,
				),
				db.prepare(
					`UPDATE cadmus_auth_tokens SET label = 'legacy' WHERE label IS NULL OR label = 'member-token'`,
				),
				db.prepare(
					`CREATE UNIQUE INDEX IF NOT EXISTS idx_cadmus_auth_tokens_id ON cadmus_auth_tokens(id)`,
				),
			]);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!msg.includes("no such table")) throw err;
		}
	}
	await db.batch([
		db.prepare(`
        CREATE TABLE IF NOT EXISTS cadmus_invites (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          email TEXT NOT NULL,
          role TEXT NOT NULL,
          invited_by TEXT,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          accepted_at INTEGER,
          revoked_at INTEGER
        )
      `),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_cadmus_invites_email ON cadmus_invites(email)`,
		),
		db.prepare(`
        CREATE TABLE IF NOT EXISTS cadmus_login_methods (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          subject TEXT NOT NULL,
          display TEXT,
          data TEXT,
          created_at INTEGER NOT NULL,
          last_used_at INTEGER,
          revoked_at INTEGER,
          UNIQUE (provider, subject)
        )
      `),
		db.prepare(`DROP TABLE IF EXISTS cadmus_passkey_challenges`),
		db.prepare(`DROP TABLE IF EXISTS cadmus_passkeys`),
		db.prepare(`
        CREATE TABLE IF NOT EXISTS cadmus_user_emails (
          email TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          kind TEXT NOT NULL
        )
      `),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_cadmus_user_emails_user ON cadmus_user_emails(user_id)`,
		),
		db.prepare(
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_cadmus_user_emails_one_primary
         ON cadmus_user_emails(user_id) WHERE kind = 'primary'`,
		),
		db.prepare(`
        CREATE TABLE IF NOT EXISTS cadmus_sessions (
          id TEXT PRIMARY KEY,
          session_family_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          login_method_id TEXT,
          token_id TEXT,
          refresh_hash TEXT NOT NULL UNIQUE,
          previous_refresh_hash TEXT,
          access_hash TEXT NOT NULL,
          access_expires_at INTEGER NOT NULL,
          elevated_until INTEGER,
          elevated_account_id TEXT,
          user_agent TEXT,
          ip_country TEXT,
          client TEXT,
          created_at INTEGER NOT NULL,
          last_used_at INTEGER NOT NULL,
          idle_expires_at INTEGER NOT NULL,
          absolute_expires_at INTEGER NOT NULL,
          revoked_at INTEGER
        )
      `),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_cadmus_sessions_access ON cadmus_sessions(access_hash)`,
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_cadmus_sessions_prev ON cadmus_sessions(previous_refresh_hash)`,
		),
		db.prepare(`
        CREATE TABLE IF NOT EXISTS cadmus_device_logins (
          id TEXT PRIMARY KEY,
          device_code_hash TEXT NOT NULL UNIQUE,
          device_secret_hash TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          user_id TEXT,
          account_id TEXT,
          role TEXT,
          token_blob TEXT,
          user_agent TEXT,
          ip_country TEXT
        )
      `),
		db.prepare(`
        CREATE TABLE IF NOT EXISTS cadmus_tickets (
          ticket_hash TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          target TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          used_at INTEGER,
          account_id TEXT,
          user_id TEXT,
          credential TEXT
        )
      `),
		db.prepare(`
        CREATE TABLE IF NOT EXISTS cadmus_bootstrap (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          claimed_at INTEGER NOT NULL,
          user_id TEXT NOT NULL
        )
      `),
	]);
	// Account admin mode was enabled in (NULL: the session's own account).
	await addColumnIfNotExists(
		db,
		"cadmus_sessions",
		"elevated_account_id",
		"TEXT",
	);
	// When an explicit x-account-id selection last used the membership; feeds
	// the next sign-in default. NULL on older rows.
	await addColumnIfNotExists(
		db,
		"cadmus_account_members",
		"last_used_at",
		"INTEGER",
	);
	// Event/ws tickets carry the account selected when they were minted.
	await addColumnIfNotExists(db, "cadmus_tickets", "account_id", "TEXT");
	await addColumnIfNotExists(db, "cadmus_tickets", "user_id", "TEXT");
	await addColumnIfNotExists(db, "cadmus_tickets", "credential", "TEXT");
	// web or cli. NULL on sessions created before the column existed.
	await addColumnIfNotExists(db, "cadmus_sessions", "client", "TEXT");
	// Captured on device/start from the CLI, then copied onto the session.
	await addColumnIfNotExists(db, "cadmus_device_logins", "user_agent", "TEXT");
	await addColumnIfNotExists(db, "cadmus_device_logins", "ip_country", "TEXT");
	const userCols = await db
		.prepare(`PRAGMA table_info(cadmus_users)`)
		.all<{ name: string }>();
	if (userCols.results.some((c) => c.name === "passkey_handle")) {
		await db
			.prepare(`ALTER TABLE cadmus_users DROP COLUMN passkey_handle`)
			.run();
	}
}

/**
 * One role set per membership. `cadmus_account_members.role` and
 * `cadmus_invites.role` are copied once and then dropped.
 */
async function migrateMemberRoles(db: D1Database): Promise<void> {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS cadmus_member_roles (
         account_id TEXT NOT NULL,
         user_id TEXT NOT NULL,
         role TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         PRIMARY KEY (account_id, user_id, role)
       )`,
		)
		.run();
	const memberCols = await db
		.prepare(`PRAGMA table_info(cadmus_account_members)`)
		.all<{ name: string }>();
	if (memberCols.results.some((c) => c.name === "role")) {
		await db
			.prepare(
				`INSERT OR IGNORE INTO cadmus_member_roles (account_id, user_id, role, created_at)
         SELECT account_id, user_id,
                CASE role WHEN 'owner' THEN 'account-admin' WHEN 'member' THEN 'user' ELSE role END,
                created_at
         FROM cadmus_account_members`,
			)
			.run();
		await db
			.prepare(`ALTER TABLE cadmus_account_members DROP COLUMN role`)
			.run();
	}
	await addColumnIfNotExists(db, "cadmus_sessions", "active_role", "TEXT");
	await addColumnIfNotExists(
		db,
		"cadmus_sessions",
		"provisional",
		"INTEGER NOT NULL DEFAULT 0",
	);
	await db
		.prepare(
			`UPDATE cadmus_sessions
         SET active_role = (
           SELECT r.role FROM cadmus_member_roles r
           WHERE r.account_id = cadmus_sessions.account_id
             AND r.user_id = cadmus_sessions.user_id
           ORDER BY CASE r.role
             WHEN 'user' THEN 0
             WHEN 'account-admin' THEN 1
             ELSE 2 END
           LIMIT 1
         )
       WHERE active_role IS NULL`,
		)
		.run();
	const inviteCols = await db
		.prepare(`PRAGMA table_info(cadmus_invites)`)
		.all<{ name: string }>();
	const inviteNames = new Set(inviteCols.results.map((c) => c.name));
	if (!inviteNames.has("roles")) {
		await addColumnIfNotExists(db, "cadmus_invites", "roles", "TEXT");
	}
	if (inviteNames.has("role")) {
		await db
			.prepare(
				`UPDATE cadmus_invites
           SET roles = json_array(CASE role
             WHEN 'owner' THEN 'account-admin'
             WHEN 'member' THEN 'user'
             ELSE role END)
         WHERE roles IS NULL`,
			)
			.run();
		await db.prepare(`ALTER TABLE cadmus_invites DROP COLUMN role`).run();
	}
}

/**
 * Legacy account-level pairing (`account.toolsEnvSecrets`, event
 * `account.tools_env_secret`) stored cadmus_dt_ tokens in
 * cadmus_tools_env_secrets and pointed env rows at them with secretId /
 * secretMissing (`secret_id`, `secret_missing`). Session credentials are now
 * a hash on the env row. Safe on an existing database: env rows are copied,
 * then the old table is dropped.
 */
async function migrateToolsEnvCredentialColumns(db: D1Database): Promise<void> {
	const cols = await db
		.prepare(`PRAGMA table_info(cadmus_tools_envs)`)
		.all<{ name: string }>();
	const names = new Set(cols.results.map((column) => column.name));
	const hasLegacy = names.has("secret_id") || names.has("secret_missing");
	const hasHash = names.has("daemon_token_hash");
	if (hasLegacy || !hasHash) {
		const hashExpr = hasHash ? "daemon_token_hash" : "NULL";
		await db.prepare(`DROP TABLE IF EXISTS cadmus_tools_envs_next`).run();
		await db
			.prepare(`
        CREATE TABLE cadmus_tools_envs_next (
          account_id TEXT NOT NULL,
          env_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          label TEXT,
          workspace_path TEXT,
          persist INTEGER NOT NULL DEFAULT 1,
          confine_to_workspace INTEGER NOT NULL DEFAULT 1,
          shared_workspace INTEGER NOT NULL DEFAULT 0,
          daemon_token_hash TEXT,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (account_id, env_id)
        )
      `)
			.run();
		await db
			.prepare(`
        INSERT INTO cadmus_tools_envs_next (
          account_id, env_id, kind, label, workspace_path, persist,
          confine_to_workspace, shared_workspace, daemon_token_hash, updated_at
        )
        SELECT account_id, env_id, kind, label, workspace_path, persist,
          confine_to_workspace, shared_workspace, ${hashExpr}, updated_at
        FROM cadmus_tools_envs
      `)
			.run();
		await db.prepare(`DROP TABLE cadmus_tools_envs`).run();
		await db
			.prepare(`ALTER TABLE cadmus_tools_envs_next RENAME TO cadmus_tools_envs`)
			.run();
	}
	await db.prepare(`DROP TABLE IF EXISTS cadmus_tools_env_secrets`).run();
	await db
		.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cadmus_tools_envs_daemon_token_hash
      ON cadmus_tools_envs (daemon_token_hash)
    `)
		.run();
}

async function addColumnIfNotExists(
	db: D1Database,
	table: string,
	column: string,
	definition: string,
): Promise<boolean> {
	const cols = await db
		.prepare(`PRAGMA table_info(${table})`)
		.all<{ name: string }>();
	if (cols.results.some((c) => c.name === column)) {
		return false;
	}
	try {
		await db
			.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
			.run();
		return true;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes("duplicate column name")) {
			return false;
		}
		// Schema 15 drops cadmus_auth_tokens. A second migrate can pass the
		// column check and then find the table already gone.
		if (table === "cadmus_auth_tokens" && msg.includes("no such table")) {
			return false;
		}
		throw err;
	}
}

export async function ensureD1Schema(
	db: D1Database,
	options: { force?: boolean } = {},
): Promise<void> {
	if (options.force) {
		initializedDbs.delete(db);
	} else if (initializedDbs.has(db)) {
		return;
	}

	while (true) {
		const existing = inFlightInits.get(db);
		if (!existing) break;
		await existing.promise;
		if (existing.forced || !options.force) {
			if (initializedDbs.has(db)) {
				return;
			}
		}
	}

	const promise = (async () => {
		try {
			if (!options.force) {
				const currentVersion = await readSchemaVersion(db);
				if (
					currentVersion !== null &&
					currentVersion >= CADMUS_SCHEMA_VERSION
				) {
					initializedDbs.add(db);
					return;
				}
			}
			await runD1SchemaMigrations(db);
			initializedDbs.add(db);
		} finally {
			inFlightInits.delete(db);
		}
	})();

	inFlightInits.set(db, { promise, forced: !!options.force });
	await promise;
}

export function wrapD1WithSchemaFallback(
	db: D1Database,
	ensureSchema: (options?: { force?: boolean }) => Promise<void>,
	invalidateCache: () => void,
): D1Database {
	return new Proxy(db, {
		get(target, prop, receiver) {
			if (prop === "batch") {
				return async (statements: D1PreparedStatement[]) => {
					try {
						return await target.batch(statements);
					} catch (error) {
						if (isMissingSchemaError(error)) {
							getLogger().warn(
								"D1 batch failed with missing schema error, forcing migration and retrying",
								{
									error: error instanceof Error ? error.message : String(error),
								},
							);
							invalidateCache();
							await ensureSchema({ force: true });
							return await target.batch(statements);
						}
						throw error;
					}
				};
			}

			if (prop === "prepare") {
				return (query: string) => {
					const stmt = target.prepare(query);
					return wrapPreparedStatement(stmt, ensureSchema, invalidateCache);
				};
			}

			return Reflect.get(target, prop, receiver);
		},
	});
}

function wrapPreparedStatement(
	stmt: D1PreparedStatement,
	ensureSchema: (options?: { force?: boolean }) => Promise<void>,
	invalidateCache: () => void,
): D1PreparedStatement {
	return new Proxy(stmt, {
		get(target, prop, receiver) {
			if (
				prop === "first" ||
				prop === "all" ||
				prop === "run" ||
				prop === "raw"
			) {
				return async (...args: unknown[]) => {
					try {
						return await (target[prop] as (...a: unknown[]) => unknown).apply(
							target,
							args,
						);
					} catch (error) {
						if (isMissingSchemaError(error)) {
							getLogger().warn(
								`D1 statement.${String(prop)} failed with missing schema error, forcing migration and retrying`,
								{
									error: error instanceof Error ? error.message : String(error),
								},
							);
							invalidateCache();
							await ensureSchema({ force: true });
							return await (target[prop] as (...a: unknown[]) => unknown).apply(
								target,
								args,
							);
						}
						throw error;
					}
				};
			}

			if (prop === "bind") {
				return (...args: unknown[]) => {
					const bound = target.bind(...args);
					return wrapPreparedStatement(bound, ensureSchema, invalidateCache);
				};
			}

			return Reflect.get(target, prop, receiver);
		},
	});
}

export interface D1AdminStoreOptions {
	db: D1Database;
	encryptionKey?: string;
	defaultTimezone?: string;
	defaultHarvestDelayMs?: number;
	edgeCache?: EdgeCache;
	bootstrapEmail?: string;
	deployEnv?: string;
}

export class D1AdminStore implements AdminStore {
	readonly #rawDb: D1Database;
	readonly #db: D1Database;
	readonly #encryptionKey: string;
	readonly #defaultTimezone: string;
	readonly #defaultHarvestDelayMs: number;
	readonly #edgeCache?: EdgeCache;
	readonly #bootstrapEmail?: string;
	readonly #deployEnv?: string;
	#initialized = false;

	constructor(options: D1AdminStoreOptions) {
		this.#rawDb = options.db;
		this.#db = wrapD1WithSchemaFallback(
			options.db,
			(opts) => this.initialize(opts),
			() => {
				this.#initialized = false;
				resetD1InitializationCache(this.#rawDb);
			},
		);
		this.#encryptionKey =
			options.encryptionKey || "default-cadmus-encryption-key-32b";
		this.#defaultTimezone = options.defaultTimezone || "UTC";
		this.#defaultHarvestDelayMs = options.defaultHarvestDelayMs ?? 60_000;
		this.#edgeCache = options.edgeCache;
		this.#bootstrapEmail = options.bootstrapEmail;
		this.#deployEnv = options.deployEnv;
	}

	async initialize(options: { force?: boolean } = {}): Promise<void> {
		if (options.force) {
			this.#initialized = false;
			resetD1InitializationCache(this.#rawDb);
		} else if (this.#initialized || isD1DatabaseInitialized(this.#rawDb)) {
			this.#initialized = true;
			await seedBootstrapSuperAdmin(this.#rawDb, this.#bootstrapEmail);
			if (this.#deployEnv === "development") {
				await seedDevTenantRoles(this.#rawDb, this.#bootstrapEmail);
			}
			return;
		}
		await ensureD1Schema(this.#rawDb, options);
		await seedBootstrapSuperAdmin(this.#rawDb, this.#bootstrapEmail);
		if (this.#deployEnv === "development") {
			await seedDevTenantRoles(this.#rawDb, this.#bootstrapEmail);
		}
		this.#initialized = true;
	}

	async #seedJustBashDefault(accountId: string, now: number): Promise<void> {
		await seedJustBashDefault(this.#db, accountId, now);
	}

	async completeLogin(
		identity: LoginIdentity,
		options: {
			bootstrapEmail?: string;
			userAgent?: string;
			ipCountry?: string;
			freshGoogleAt?: number;
			chooseRole?: boolean;
		} = {},
	): Promise<LoginResult> {
		await this.initialize();
		return completeLogin(this.#db, identity, options);
	}

	async createTicket(
		sessionId: string,
		target: TicketTarget,
		accountId?: string,
	) {
		await this.initialize();
		return createTicket(this.#db, sessionId, target, accountId);
	}

	async consumeTicket(ticket: string, target: TicketTarget) {
		await this.initialize();
		return consumeTicket(this.#db, ticket, target);
	}

	async listSessions(userId: string) {
		await this.initialize();
		return listSessions(this.#db, userId);
	}

	async revokeOwnSession(userId: string, sessionId: string) {
		await this.initialize();
		return revokeOwnSession(this.#db, userId, sessionId);
	}

	async inviteMember(input: {
		accountId: string;
		invitedBy: string;
		email: string;
		roles?: Role[];
		ttlMs?: number;
		actorKind?: "user" | "super-admin";
	}) {
		await this.initialize();
		return inviteMember(this.#db, input);
	}

	async listInvites(accountId: string) {
		await this.initialize();
		return listInvites(this.#db, accountId);
	}

	async revokeInvite(input: {
		accountId: string;
		inviteId: string;
		actor: string;
	}) {
		await this.initialize();
		return revokeInvite(this.#db, input);
	}

	async updateMemberRole(input: {
		accountId: string;
		userId: string;
		op: "grant" | "revoke";
		role: Role;
		actor: string;
		actorKind?: "user" | "super-admin";
	}) {
		await this.initialize();
		return updateMemberRole(this.#db, input);
	}

	async removeMember(input: {
		accountId: string;
		userId: string;
		actor: string;
		actorKind?: "user" | "super-admin";
	}) {
		await this.initialize();
		return removeMember(this.#db, input);
	}

	async revokeOtherSessions(userId: string, currentSessionId: string) {
		await this.initialize();
		return revokeOtherSessions(this.#db, userId, currentSessionId);
	}

	async listMemberships(userId: string) {
		await this.initialize();
		return listMemberships(this.#db, userId);
	}

	async listLoginMethods(userId: string) {
		await this.initialize();
		return listLoginMethods(this.#db, userId);
	}

	async userProfile(userId: string) {
		await this.initialize();
		return userProfile(this.#db, userId);
	}

	async revokeLoginMethod(userId: string, methodId: string) {
		await this.initialize();
		return revokeLoginMethod(this.#db, userId, methodId);
	}

	async assumeRole(input: {
		rawAccess: string;
		role: Role;
		accountId: string;
		userAgent?: string;
	}) {
		await this.initialize();
		const caller = await resolveAccessToken(this.#db, input.rawAccess);
		if (!caller) return { ok: false as const, code: "unauthorized" as const };
		return assumeStoredRole(this.#db, {
			sessionId: caller.sessionId,
			userId: caller.userId,
			fromAccountId: caller.accountId,
			fromRole: caller.role,
			provisional: caller.provisional === true,
			accountId: input.accountId,
			role: input.role,
			userAgent: input.userAgent,
		});
	}

	async createSession(input: CreateSessionInput): Promise<SessionTokens> {
		await this.initialize();
		return createSession(this.#db, input);
	}

	async resolveSession(
		sessionId: string,
		accountId?: string,
	): Promise<SessionIdentity | undefined> {
		await this.initialize();
		return resolveSessionById(this.#db, sessionId, accountId);
	}

	async resolveAccessToken(
		rawToken: string,
		selectedAccountId?: string,
	): Promise<SessionIdentity | undefined> {
		await this.initialize();
		return resolveAccessToken(this.#db, rawToken, selectedAccountId);
	}

	async rotateRefreshToken(rawRefresh: string): Promise<RefreshResult> {
		await this.initialize();
		return rotateRefreshToken(this.#db, rawRefresh);
	}

	async startDeviceLogin(
		input: { now?: number; userAgent?: string; ipCountry?: string } = {},
	): Promise<DeviceLoginStart> {
		await this.initialize();
		return startDeviceLogin(this.#db, input);
	}

	async pollDeviceLogin(
		deviceSecret: string,
		now?: number,
	): Promise<DevicePollResult> {
		await this.initialize();
		return pollDeviceLogin(this.#db, this.#encryptionKey, deviceSecret, now);
	}

	async approveDeviceLogin(input: {
		deviceCode: string;
		identity: SessionIdentity;
		now?: number;
	}): Promise<DeviceDecisionResult> {
		await this.initialize();
		return approveDeviceLogin(this.#db, this.#encryptionKey, input);
	}

	async denyDeviceLogin(
		deviceCode: string,
		now?: number,
	): Promise<DeviceDecisionResult> {
		await this.initialize();
		return denyDeviceLogin(this.#db, deviceCode, now);
	}

	async revokeSessionByRefresh(rawRefresh: string): Promise<boolean> {
		await this.initialize();
		return revokeSessionByRefresh(this.#db, rawRefresh);
	}

	async revokeSession(sessionId: string): Promise<boolean> {
		await this.initialize();
		return revokeSession(this.#db, sessionId);
	}

	async listAccountMembers(accountId: string) {
		await this.initialize();
		return listAccountMembers(this.#db, accountId);
	}

	async setUserDisabled(input: {
		userId: string;
		disabled: boolean;
		actor: string;
	}) {
		await this.initialize();
		return setUserDisabled(this.#db, input);
	}

	async revokeUserSessions(input: { userId: string; actor: string }) {
		await this.initialize();
		return revokeUserSessions(this.#db, input);
	}

	async listSystemAccounts(): Promise<SystemAccount[]> {
		await this.initialize();
		return listSystemAccounts(this.#db);
	}

	async createSystemAccount(input: {
		name: string;
		timezone?: string;
		actor: string;
		ownerEmail: string;
	}): Promise<SystemResult<{ account: SystemAccount }>> {
		await this.initialize();
		const name = cleanName(input.name);
		if (!name) {
			return {
				ok: false,
				code: "invalid",
				message: "Account name must be 1 to 80 characters",
			};
		}
		const timezone = input.timezone?.trim() || this.#defaultTimezone;
		try {
			new Intl.DateTimeFormat("en-US", { timeZone: timezone });
		} catch {
			return { ok: false, code: "invalid", message: "Unknown timezone" };
		}
		const ownerEmail = normalizeLoginEmail(input.ownerEmail);
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
			return { ok: false, code: "invalid", message: "ownerEmail is not valid" };
		}
		const now = Date.now();
		const bytes = crypto.getRandomValues(new Uint8Array(8));
		const accountId = `acc_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
		const owner = insertPrimaryUserStatements(
			this.#db,
			ownerEmail,
			ownerEmail,
			now,
		);
		await this.#db.batch([
			...owner.statements,
			this.#db
				.prepare(
					`INSERT INTO cadmus_accounts (id, name, timezone, created_at, parent_account_id, status, default_tools_env_json) VALUES (?1, ?2, ?3, ?4, '${SYSTEM_ACCOUNT_ID}', 'active', ?5)`,
				)
				.bind(
					accountId,
					name,
					timezone,
					now,
					JSON.stringify({ envId: "jb_default" }),
				),
			this.#db
				.prepare(
					`INSERT INTO cadmus_account_members (account_id, user_id, created_at)
           SELECT ?1, e.user_id, ?3
           FROM cadmus_user_emails e WHERE e.email = ?2`,
				)
				.bind(accountId, ownerEmail, now),
			this.#db
				.prepare(
					`INSERT OR IGNORE INTO cadmus_member_roles (account_id, user_id, role, created_at)
           SELECT ?1, e.user_id, 'account-admin', ?3
           FROM cadmus_user_emails e WHERE e.email = ?2`,
				)
				.bind(accountId, ownerEmail, now),
			accountCreateAudit(
				this.#db,
				{ accountId, actor: input.actor, name },
				now,
			),
			// In the same batch, so a failure leaves no half-created account.
			seedJustBashStatement(this.#db, accountId, now),
		]);
		const created = (await this.listSystemAccounts()).find(
			(a) => a.id === accountId,
		);
		if (!created) {
			return { ok: false, code: "not_found", message: "Account not found" };
		}
		return { ok: true, account: created };
	}

	async setSystemAccountStatus(input: {
		accountId: string;
		status: "active" | "suspended";
		actor: string;
	}) {
		await this.initialize();
		return setAccountStatus(this.#db, input);
	}

	async renameSystemAccount(input: {
		accountId: string;
		name: string;
		actor: string;
	}) {
		await this.initialize();
		return renameAccount(this.#db, input);
	}

	async listSystemAudit(input: {
		limit: number;
		accountId?: string;
		before?: number;
		beforeId?: string;
	}): Promise<SystemAuditEvent[]> {
		await this.initialize();
		return listSystemAudit(this.#db, input);
	}

	async listAccountAudit(input: {
		accountId: string;
		limit: number;
		before?: number;
		beforeId?: string;
	}): Promise<SystemAuditEvent[]> {
		await this.initialize();
		return listAccountAudit(this.#db, input);
	}

	async sessionRefusalReason(sessionId: string, accountId?: string) {
		await this.initialize();
		return sessionRefusalReason(this.#db, sessionId, accountId);
	}

	async startElevation(
		sessionId: string,
		accountId?: string,
	): Promise<number | undefined> {
		await this.initialize();
		return startElevation(this.#db, sessionId, Date.now(), accountId);
	}

	async endElevation(sessionId: string): Promise<boolean> {
		await this.initialize();
		return endElevation(this.#db, sessionId);
	}

	async auditElevatedCommand(
		sessionId: string,
		commandType: string,
		phase: ElevatedCommandPhase,
		operation: ElevatedOperation,
	): Promise<void> {
		await this.initialize();
		return auditElevatedCommand(
			this.#db,
			sessionId,
			commandType,
			phase,
			operation,
		);
	}

	async ensureAccountAndUser(input: {
		accountId: string;
		userId: string;
		accountName?: string;
		userName?: string;
		role?: Role;
		timezone?: string;
	}): Promise<AccountRecord> {
		await this.initialize();
		if (input.accountId === SYSTEM_ACCOUNT_ID) {
			throw new Error(`'${SYSTEM_ACCOUNT_ID}' is a reserved account id`);
		}
		const now = Date.now();
		const accountName = input.accountName ?? input.accountId;
		const userName = input.userName ?? input.userId;
		const role = normalizeRole(input.role) ?? "account-admin";
		const timezone = input.timezone ?? this.#defaultTimezone;

		const inserted = await this.#db
			.prepare(
				`INSERT OR IGNORE INTO cadmus_accounts (id, name, timezone, created_at, parent_account_id, status) VALUES (?1, ?2, ?3, ?4, '${SYSTEM_ACCOUNT_ID}', 'active')`,
			)
			.bind(input.accountId, accountName, timezone, now)
			.run();
		await this.#db.batch([
			this.#db
				.prepare(
					`INSERT OR IGNORE INTO cadmus_users (id, name, email, created_at) VALUES (?1, ?2, NULL, ?3)`,
				)
				.bind(input.userId, userName, now),
			this.#db
				.prepare(
					`INSERT OR IGNORE INTO cadmus_account_members (account_id, user_id, created_at) VALUES (?1, ?2, ?3)`,
				)
				.bind(input.accountId, input.userId, now),
			this.#db
				.prepare(
					`INSERT OR IGNORE INTO cadmus_member_roles (account_id, user_id, role, created_at) VALUES (?1, ?2, ?3, ?4)`,
				)
				.bind(input.accountId, input.userId, role, now),
		]);
		if ((inserted.meta?.changes ?? 0) > 0) {
			await this.#seedJustBashDefault(input.accountId, now);
			await this.#db
				.prepare(
					`UPDATE cadmus_accounts SET default_tools_env_json = ?1 WHERE id = ?2`,
				)
				.bind(JSON.stringify({ envId: "jb_default" }), input.accountId)
				.run();
		}

		const row = await this.getAccount(input.accountId);
		return (
			row ?? {
				id: input.accountId,
				name: accountName,
				timezone,
				createdAt: now,
			}
		);
	}

	async getAccount(accountId: string): Promise<AccountRecord | undefined> {
		await this.initialize();
		const row = await this.#db
			.prepare(
				`SELECT id, name, timezone, created_at, default_tools_env_json FROM cadmus_accounts WHERE id = ?1`,
			)
			.bind(accountId)
			.first<{
				id: string;
				name: string;
				timezone?: string;
				created_at: number;
				default_tools_env_json?: string | null;
			}>();
		if (!row) return undefined;
		return {
			id: row.id,
			name: row.name,
			timezone: row.timezone ?? this.#defaultTimezone,
			createdAt: row.created_at,
			defaultToolsEnv: parseDefaultToolsEnv(row.default_tools_env_json),
		};
	}

	async updateAccount(
		accountId: string,
		patch: {
			name?: string;
			timezone?: string;
			defaultToolsEnv?: { envId: string } | null;
		},
	): Promise<AccountRecord> {
		await this.initialize();
		const existing = await this.getAccount(accountId);
		if (!existing) {
			throw new Error(`Account '${accountId}' not found`);
		}
		const nextName =
			patch.name !== undefined ? patch.name.trim() : existing.name;
		const nextTz =
			patch.timezone !== undefined ? patch.timezone.trim() : existing.timezone;
		const setDefault = Object.hasOwn(patch, "defaultToolsEnv");
		const nextDefault = setDefault
			? patch.defaultToolsEnv
			: existing.defaultToolsEnv;
		await this.#db
			.prepare(
				`UPDATE cadmus_accounts
         SET name = ?1, timezone = ?2, default_tools_env_json = ?3
         WHERE id = ?4`,
			)
			.bind(
				nextName,
				nextTz,
				setDefault
					? nextDefault
						? JSON.stringify(nextDefault)
						: null
					: existing.defaultToolsEnv
						? JSON.stringify(existing.defaultToolsEnv)
						: null,
				accountId,
			)
			.run();

		if (patch.timezone !== undefined) {
			await this.#db
				.prepare(
					`UPDATE cadmus_families SET timezone = ?1 WHERE account_id = ?2 AND family_id IN ('default', 'default-family')`,
				)
				.bind(nextTz, accountId)
				.run();
			if (this.#edgeCache) {
				await Promise.all([
					this.#edgeCache.invalidateFamily(accountId, "default"),
					this.#edgeCache.invalidateFamily(accountId, "default-family"),
				]);
			}
		}

		return {
			...existing,
			name: nextName,
			timezone: nextTz,
			defaultToolsEnv: nextDefault ?? null,
		};
	}

	async listMembers(accountId: string): Promise<AccountMember[]> {
		await this.initialize();
		const { results } = await this.#db
			.prepare(
				`SELECT m.account_id, m.user_id, m.created_at,
                (SELECT json_group_array(r.role) FROM cadmus_member_roles r
                  WHERE r.account_id = m.account_id AND r.user_id = m.user_id) AS roles
         FROM cadmus_account_members m
         WHERE m.account_id = ?1
         ORDER BY m.created_at ASC, m.user_id ASC`,
			)
			.bind(accountId)
			.all<{
				account_id: string;
				user_id: string;
				roles: string;
				created_at: number;
			}>();
		return results.map((r) => ({
			accountId: r.account_id,
			userId: r.user_id,
			roles: parseStoredRoles(r.roles),
			createdAt: r.created_at,
		}));
	}

	async addMember(input: {
		accountId: string;
		userId: string;
		name?: string;
		email?: string;
		roles?: Role[];
	}): Promise<AccountMember> {
		await this.initialize();
		const now = Date.now();
		const roles = (input.roles?.length ? input.roles : ["user"]).filter(isRole);
		const stored = roles.length > 0 ? roles : (["user"] as const);
		const statements = [
			this.#db
				.prepare(
					`INSERT INTO cadmus_users (id, name, email, created_at)
           VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, email = COALESCE(excluded.email, cadmus_users.email)`,
				)
				.bind(
					input.userId,
					input.name ?? input.userId,
					input.email ?? null,
					now,
				),
			this.#db
				.prepare(
					`INSERT INTO cadmus_account_members (account_id, user_id, created_at)
           VALUES (?1, ?2, ?3)
           ON CONFLICT(account_id, user_id) DO NOTHING`,
				)
				.bind(input.accountId, input.userId, now),
			...stored.map((role) =>
				this.#db
					.prepare(
						`INSERT OR IGNORE INTO cadmus_member_roles (account_id, user_id, role, created_at)
             VALUES (?1, ?2, ?3, ?4)`,
					)
					.bind(input.accountId, input.userId, role, now),
			),
		];

		await this.#db.batch(statements);

		return {
			accountId: input.accountId,
			userId: input.userId,
			roles: [...stored],
			createdAt: now,
		};
	}

	async listCredentials(accountId: string): Promise<CredentialSummary[]> {
		await this.initialize();
		const { results } = await this.#db
			.prepare(
				`SELECT provider_id, cred_type, updated_at
         FROM cadmus_account_credentials
         WHERE account_id = ?1
         ORDER BY provider_id ASC`,
			)
			.bind(accountId)
			.all<{
				provider_id: string;
				cred_type: "api_key" | "oauth";
				updated_at: number;
			}>();
		return results.map((r) => ({
			providerId: r.provider_id,
			type: r.cred_type,
			updatedAt: r.updated_at,
		}));
	}

	async getCredential(
		accountId: string,
		providerId: string,
	): Promise<Credential | undefined> {
		await this.initialize();
		const row = await this.#db
			.prepare(
				`SELECT iv_hex, cipher_hex
         FROM cadmus_account_credentials
         WHERE account_id = ?1 AND provider_id = ?2`,
			)
			.bind(accountId, providerId)
			.first<{ iv_hex: string; cipher_hex: string }>();
		if (!row) return undefined;
		return decryptJson<Credential>(
			this.#encryptionKey,
			accountId,
			row.iv_hex,
			row.cipher_hex,
		);
	}

	async getAllCredentials(
		accountId: string,
	): Promise<Record<string, Credential>> {
		await this.initialize();
		const { results } = await this.#db
			.prepare(
				`SELECT provider_id, iv_hex, cipher_hex
         FROM cadmus_account_credentials
         WHERE account_id = ?1`,
			)
			.bind(accountId)
			.all<{ provider_id: string; iv_hex: string; cipher_hex: string }>();
		const out: Record<string, Credential> = {};
		for (const row of results) {
			out[row.provider_id] = await decryptJson<Credential>(
				this.#encryptionKey,
				accountId,
				row.iv_hex,
				row.cipher_hex,
			);
		}
		return out;
	}

	async setCredential(
		accountId: string,
		providerId: string,
		input: CredentialInput | Credential,
	): Promise<CredentialSummary> {
		await this.initialize();
		const normalized = normalizeCredential(input);
		const { ivHex, cipherHex } = await encryptJson(
			this.#encryptionKey,
			accountId,
			normalized,
		);
		const now = Date.now();
		await this.#db
			.prepare(
				`INSERT INTO cadmus_account_credentials (account_id, provider_id, cred_type, iv_hex, cipher_hex, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(account_id, provider_id) DO UPDATE SET
           cred_type = excluded.cred_type,
           iv_hex = excluded.iv_hex,
           cipher_hex = excluded.cipher_hex,
           updated_at = excluded.updated_at`,
			)
			.bind(accountId, providerId, normalized.type, ivHex, cipherHex, now)
			.run();
		return {
			providerId,
			type: normalized.type,
			updatedAt: now,
		};
	}

	async deleteCredential(
		accountId: string,
		providerId: string,
	): Promise<boolean> {
		await this.initialize();
		const existing = await this.#db
			.prepare(
				`SELECT provider_id FROM cadmus_account_credentials WHERE account_id = ?1 AND provider_id = ?2`,
			)
			.bind(accountId, providerId)
			.first();
		if (!existing) return false;
		await this.#db
			.prepare(
				`DELETE FROM cadmus_account_credentials WHERE account_id = ?1 AND provider_id = ?2`,
			)
			.bind(accountId, providerId)
			.run();
		return true;
	}

	async listFamilies(accountId: string): Promise<FamilyRecord[]> {
		await this.initialize();
		const { results } = await this.#db
			.prepare(
				`SELECT account_id, family_id, name, do_name, timezone, harvest_delay_ms, team_leader_bot_id, created_at
         FROM cadmus_families
         WHERE account_id = ?1
         ORDER BY created_at ASC, family_id ASC`,
			)
			.bind(accountId)
			.all<FamilySqlRow>();
		return results.map(toFamilyRecord);
	}

	async getFamily(
		accountId: string,
		familyId: string,
	): Promise<FamilyRecord | undefined> {
		await this.initialize();
		const row = await this.#db
			.prepare(
				`SELECT account_id, family_id, name, do_name, timezone, harvest_delay_ms, team_leader_bot_id, created_at
         FROM cadmus_families
         WHERE account_id = ?1 AND family_id = ?2`,
			)
			.bind(accountId, familyId)
			.first<FamilySqlRow>();
		return row ? toFamilyRecord(row) : undefined;
	}

	async ensureFamily(
		accountId: string,
		familyId: string,
		defaults?: { name?: string; timezone?: string; harvestDelayMs?: number },
	): Promise<FamilyRecord> {
		await this.initialize();
		const existing = await this.getFamily(accountId, familyId);
		if (existing) return existing;
		const now = Date.now();
		const doName = toDoName(accountId, familyId);
		const account = await this.getAccount(accountId);
		const name = defaults?.name ?? familyId;
		const timezone =
			defaults?.timezone ?? account?.timezone ?? this.#defaultTimezone;
		const harvestDelayMs =
			defaults?.harvestDelayMs ?? this.#defaultHarvestDelayMs;
		await this.#db
			.prepare(
				`INSERT OR IGNORE INTO cadmus_families (account_id, family_id, name, do_name, timezone, harvest_delay_ms, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
			)
			.bind(accountId, familyId, name, doName, timezone, harvestDelayMs, now)
			.run();
		return (
			(await this.getFamily(accountId, familyId)) ?? {
				accountId,
				familyId,
				name,
				doName,
				timezone,
				harvestDelayMs,
				createdAt: now,
			}
		);
	}

	async createFamily(
		accountId: string,
		input: {
			familyId?: string;
			name: string;
			timezone?: string;
			harvestDelayMs?: number;
		},
	): Promise<FamilyRecord> {
		await this.initialize();
		const familyId = input.familyId
			? slugifyId(input.familyId)
			: slugifyId(input.name);
		const existing = await this.getFamily(accountId, familyId);
		if (existing) {
			throw new Error(
				`Family '${familyId}' already exists in account '${accountId}'`,
			);
		}
		const now = Date.now();
		const doName = toDoName(accountId, familyId);
		const account = await this.getAccount(accountId);
		const timezone =
			input.timezone ?? account?.timezone ?? this.#defaultTimezone;
		const harvestDelayMs = input.harvestDelayMs ?? this.#defaultHarvestDelayMs;
		await this.#db
			.prepare(
				`INSERT INTO cadmus_families (account_id, family_id, name, do_name, timezone, harvest_delay_ms, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
			)
			.bind(
				accountId,
				familyId,
				input.name.trim(),
				doName,
				timezone,
				harvestDelayMs,
				now,
			)
			.run();
		const result: FamilyRecord = {
			accountId,
			familyId,
			name: input.name.trim(),
			doName,
			timezone,
			harvestDelayMs,
			createdAt: now,
		};
		if (this.#edgeCache) {
			await this.#edgeCache.setFamily(accountId, familyId, result);
		}
		return result;
	}

	async updateFamily(
		accountId: string,
		familyId: string,
		patch: FamilySettingsPatch,
	): Promise<FamilyRecord | undefined> {
		await this.initialize();
		const existing = await this.getFamily(accountId, familyId);
		if (!existing) return undefined;
		const nextName =
			patch.name !== undefined ? patch.name.trim() : existing.name;
		const nextTz =
			patch.timezone !== undefined ? patch.timezone.trim() : existing.timezone;
		const nextDelay =
			patch.harvestDelayMs !== undefined
				? patch.harvestDelayMs
				: existing.harvestDelayMs;
		const nextLeader =
			patch.teamLeaderBotId !== undefined
				? patch.teamLeaderBotId
				: (existing.teamLeaderBotId ?? null);
		await this.#db
			.prepare(
				`UPDATE cadmus_families
         SET name = ?1, timezone = ?2, harvest_delay_ms = ?3, team_leader_bot_id = ?4
         WHERE account_id = ?5 AND family_id = ?6`,
			)
			.bind(nextName, nextTz, nextDelay, nextLeader, accountId, familyId)
			.run();
		if (this.#edgeCache) {
			await this.#edgeCache.invalidateFamily(accountId, familyId);
		}
		const updated: FamilyRecord = {
			...existing,
			name: nextName,
			timezone: nextTz,
			harvestDelayMs: nextDelay,
		};
		if (nextLeader) {
			updated.teamLeaderBotId = nextLeader;
		} else {
			delete updated.teamLeaderBotId;
		}
		return updated;
	}

	async deleteFamily(accountId: string, familyId: string): Promise<boolean> {
		await this.initialize();
		const existing = await this.getFamily(accountId, familyId);
		if (!existing) return false;
		await this.#db
			.prepare(
				`DELETE FROM cadmus_families WHERE account_id = ?1 AND family_id = ?2`,
			)
			.bind(accountId, familyId)
			.run();
		if (this.#edgeCache) {
			await this.#edgeCache.invalidateFamily(accountId, familyId);
		}
		return true;
	}

	async listToolsEnvs(accountId: string): Promise<StoredToolsEnv[]> {
		await this.initialize();
		const { results } = await this.#db
			.prepare(
				`SELECT env_id, kind, label, workspace_path, persist, confine_to_workspace,
                confinement_policy, shared_workspace, updated_at
         FROM cadmus_tools_envs
         WHERE account_id = ?1
         ORDER BY env_id ASC`,
			)
			.bind(accountId)
			.all<ToolsEnvSqlRow>();
		return results.map(mapToolsEnv);
	}

	async getToolsEnv(
		accountId: string,
		envId: string,
	): Promise<StoredToolsEnv | undefined> {
		await this.initialize();
		const row = await this.#db
			.prepare(
				`SELECT env_id, kind, label, workspace_path, persist, confine_to_workspace,
                confinement_policy, shared_workspace, updated_at
         FROM cadmus_tools_envs
         WHERE account_id = ?1 AND env_id = ?2`,
			)
			.bind(accountId, envId)
			.first<ToolsEnvSqlRow>();
		return row ? mapToolsEnv(row) : undefined;
	}

	async createToolsEnv(
		accountId: string,
		input: {
			envId: string;
			kind: "just-bash" | "local-daemon";
			label?: string;
			persist: boolean;
			confineToWorkspace: boolean;
			confinementPolicy?: ConfinementPolicy;
			sharedWorkspace: boolean;
		},
	): Promise<StoredToolsEnv> {
		await this.initialize();
		const now = Date.now();
		const policy: ConfinementPolicy =
			input.confinementPolicy ??
			(input.confineToWorkspace ? "required" : "disabled");
		await this.#db
			.prepare(
				`INSERT INTO cadmus_tools_envs (
          account_id, env_id, kind, label, workspace_path, persist,
          confine_to_workspace, confinement_policy, shared_workspace, updated_at
        ) VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8, ?9)`,
			)
			.bind(
				accountId,
				input.envId,
				input.kind,
				input.label ?? null,
				input.persist ? 1 : 0,
				policy === "required" ? 1 : 0,
				policy,
				input.sharedWorkspace ? 1 : 0,
				now,
			)
			.run();
		const created = await this.getToolsEnv(accountId, input.envId);
		if (!created)
			throw new Error(`Failed to create tools env '${input.envId}'`);
		return created;
	}

	async updateToolsEnv(
		accountId: string,
		envId: string,
		patch: {
			label?: string;
			persist?: boolean;
			confineToWorkspace?: boolean;
			confinementPolicy?: ConfinementPolicy;
			sharedWorkspace?: boolean;
		},
	): Promise<StoredToolsEnv | undefined> {
		await this.initialize();
		const existing = await this.getToolsEnv(accountId, envId);
		if (!existing) return undefined;
		const label =
			patch.label !== undefined ? patch.label : (existing.label ?? null);
		const persist = patch.persist ?? existing.persist;
		const policy: ConfinementPolicy =
			patch.confinementPolicy ??
			(patch.confineToWorkspace !== undefined
				? patch.confineToWorkspace
					? "required"
					: "disabled"
				: (existing.confinementPolicy ??
					(existing.confineToWorkspace ? "required" : "disabled")));
		const confine = policy === "required";
		const shared = patch.sharedWorkspace ?? existing.sharedWorkspace;
		await this.#db
			.prepare(
				`UPDATE cadmus_tools_envs
         SET label = ?1, persist = ?2, confine_to_workspace = ?3,
             confinement_policy = ?4, shared_workspace = ?5, updated_at = ?6
         WHERE account_id = ?7 AND env_id = ?8`,
			)
			.bind(
				label,
				persist ? 1 : 0,
				confine ? 1 : 0,
				policy,
				shared ? 1 : 0,
				Date.now(),
				accountId,
				envId,
			)
			.run();
		return this.getToolsEnv(accountId, envId);
	}

	async deleteToolsEnv(accountId: string, envId: string): Promise<boolean> {
		await this.initialize();
		const result = await this.#db
			.prepare(
				`DELETE FROM cadmus_tools_envs WHERE account_id = ?1 AND env_id = ?2`,
			)
			.bind(accountId, envId)
			.run();
		if ((result.meta?.changes ?? 0) === 0) return false;
		await this.#db
			.prepare(
				`UPDATE cadmus_accounts
         SET default_tools_env_json = NULL
         WHERE id = ?1 AND json_extract(default_tools_env_json, '$.envId') = ?2`,
			)
			.bind(accountId, envId)
			.run();
		return true;
	}

	async assignToolsEnvDaemonToken(
		accountId: string,
		envId: string,
		tokenHash: string,
		label?: string,
	): Promise<void> {
		await this.initialize();
		await this.#db
			.prepare(
				`UPDATE cadmus_tools_envs
         SET daemon_token_hash = ?1, label = COALESCE(?2, label), updated_at = ?3
         WHERE account_id = ?4 AND env_id = ?5 AND kind = 'local-daemon'`,
			)
			.bind(tokenHash, label ?? null, Date.now(), accountId, envId)
			.run();
	}

	async clearToolsEnvDaemonToken(
		accountId: string,
		envId: string,
	): Promise<void> {
		await this.initialize();
		await this.#db
			.prepare(
				`UPDATE cadmus_tools_envs
         SET daemon_token_hash = NULL, updated_at = ?1
         WHERE account_id = ?2 AND env_id = ?3 AND kind = 'local-daemon'`,
			)
			.bind(Date.now(), accountId, envId)
			.run();
	}

	async resolveToolsEnvDaemonToken(
		tokenHash: string,
	): Promise<{ accountId: string; envId: string } | undefined> {
		await this.initialize();
		const row = await this.#db
			.prepare(
				`SELECT account_id, env_id
         FROM cadmus_tools_envs
         WHERE daemon_token_hash = ?1 AND kind = 'local-daemon'`,
			)
			.bind(tokenHash)
			.first<{ account_id: string; env_id: string }>();
		if (!row) return undefined;
		return { accountId: row.account_id, envId: row.env_id };
	}
}

function parseDefaultToolsEnv(
	raw: string | null | undefined,
): ToolsEnvBinding | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as { envId?: string };
		if (!parsed?.envId) return null;
		return { envId: parsed.envId };
	} catch {
		return null;
	}
}

interface ToolsEnvSqlRow {
	env_id: string;
	kind: string;
	label: string | null;
	workspace_path: string | null;
	persist: number;
	confine_to_workspace: number;
	confinement_policy?: string | null;
	shared_workspace: number;
	updated_at: number;
}

function mapToolsEnv(row: ToolsEnvSqlRow): StoredToolsEnv {
	const confinementPolicy: ConfinementPolicy =
		(row.confinement_policy as ConfinementPolicy) ??
		(row.confine_to_workspace !== 0 ? "required" : "disabled");
	const record: StoredToolsEnv = {
		envId: row.env_id,
		kind: row.kind === "local-daemon" ? "local-daemon" : "just-bash",
		persist: row.persist !== 0,
		confineToWorkspace: confinementPolicy === "required",
		confinementPolicy,
		sharedWorkspace: row.shared_workspace !== 0,
		updatedAt: Number(row.updated_at),
	};
	if (row.label) record.label = row.label;
	return record;
}

interface FamilySqlRow {
	account_id: string;
	family_id: string;
	name: string;
	do_name: string;
	timezone: string;
	harvest_delay_ms: number;
	team_leader_bot_id: string | null;
	created_at: number;
}

function toFamilyRecord(row: FamilySqlRow): FamilyRecord {
	const record: FamilyRecord = {
		accountId: row.account_id,
		familyId: row.family_id,
		name: row.name,
		doName: row.do_name,
		timezone: row.timezone,
		harvestDelayMs: row.harvest_delay_ms,
		createdAt: row.created_at,
	};
	if (row.team_leader_bot_id) {
		record.teamLeaderBotId = row.team_leader_bot_id;
	}
	return record;
}
