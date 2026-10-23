import type { Credential } from "@earendil-works/pi-ai";
import type {
	AccountMember,
	CredentialInput,
	CredentialSummary,
	FamilyRecord,
	ToolsEnvBinding,
} from "../protocol.js";
import type {
	AccountRecord,
	AdminStore,
	AuthenticatedIdentity,
	FamilySettingsPatch,
	StoredToolsEnv,
	ToolsEnvSecretMeta,
} from "./admin-interface.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toDoName(accountId: string, familyId: string): string {
	return `cadmus:${accountId}:${familyId}`;
}

export async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

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

export class D1AdminStore implements AdminStore {
	readonly #db: D1Database;
	readonly #encryptionKey: string;
	readonly #defaultTimezone: string;
	readonly #defaultHarvestDelayMs: number;
	#initialized = false;

	constructor(options: {
		db: D1Database;
		encryptionKey?: string;
		defaultTimezone?: string;
		defaultHarvestDelayMs?: number;
	}) {
		this.#db = options.db;
		this.#encryptionKey =
			options.encryptionKey || "default-cadmus-encryption-key-32b";
		this.#defaultTimezone = options.defaultTimezone || "UTC";
		this.#defaultHarvestDelayMs = options.defaultHarvestDelayMs ?? 60_000;
	}

	async initialize(): Promise<void> {
		if (this.#initialized) return;
		await this.#db.batch([
			this.#db.prepare(`
        CREATE TABLE IF NOT EXISTS cadmus_accounts (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          timezone TEXT NOT NULL DEFAULT 'UTC',
          created_at INTEGER NOT NULL
        )
      `),
			this.#db.prepare(`
        CREATE TABLE IF NOT EXISTS cadmus_users (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT,
          created_at INTEGER NOT NULL
        )
      `),
			this.#db.prepare(`
        CREATE TABLE IF NOT EXISTS cadmus_account_members (
          account_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          role TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (account_id, user_id)
        )
      `),
			this.#db.prepare(`
        CREATE TABLE IF NOT EXISTS cadmus_auth_tokens (
          token_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          label TEXT,
          created_at INTEGER NOT NULL
        )
      `),
			this.#db.prepare(`
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
			this.#db.prepare(`
        CREATE TABLE IF NOT EXISTS cadmus_families (
          account_id TEXT NOT NULL,
          family_id TEXT NOT NULL,
          name TEXT NOT NULL,
          do_name TEXT NOT NULL,
          timezone TEXT NOT NULL,
          harvest_delay_ms INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (account_id, family_id)
        )
      `),
		]);

		const accountCols = await this.#db
			.prepare("PRAGMA table_info(cadmus_accounts)")
			.all<{ name: string }>();
		if (!accountCols.results.some((c) => c.name === "timezone")) {
			await this.#db
				.prepare(
					"ALTER TABLE cadmus_accounts ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC'",
				)
				.run();
		}

		await this.#db
			.prepare(
				`CREATE TABLE IF NOT EXISTS cadmus_tools_envs (
          account_id TEXT NOT NULL,
          env_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          label TEXT,
          workspace_path TEXT,
          persist INTEGER NOT NULL DEFAULT 1,
          confine_to_workspace INTEGER NOT NULL DEFAULT 1,
          shared_workspace INTEGER NOT NULL DEFAULT 0,
          secret_id TEXT,
          secret_missing INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (account_id, env_id)
        )`,
			)
			.run();
		const envCols = await this.#db
			.prepare("PRAGMA table_info(cadmus_tools_envs)")
			.all<{ name: string }>();
		if (!envCols.results.some((column) => column.name === "secret_missing")) {
			await this.#db
				.prepare(
					"ALTER TABLE cadmus_tools_envs ADD COLUMN secret_missing INTEGER NOT NULL DEFAULT 0",
				)
				.run();
		}
		await this.#db
			.prepare(
				`CREATE TABLE IF NOT EXISTS cadmus_tools_env_secrets (
          account_id TEXT NOT NULL,
          secret_id TEXT NOT NULL,
          label TEXT,
          kind TEXT NOT NULL,
          token_hash TEXT NOT NULL,
          iv_hex TEXT NOT NULL,
          cipher_hex TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (account_id, secret_id)
        )`,
			)
			.run();
		await this.#db
			.prepare(
				`CREATE UNIQUE INDEX IF NOT EXISTS idx_cadmus_tools_env_secrets_token_hash
         ON cadmus_tools_env_secrets (token_hash)`,
			)
			.run();

		const accountColsAfter = await this.#db
			.prepare("PRAGMA table_info(cadmus_accounts)")
			.all<{ name: string }>();
		if (
			!accountColsAfter.results.some((c) => c.name === "default_tools_env_json")
		) {
			await this.#db
				.prepare(
					"ALTER TABLE cadmus_accounts ADD COLUMN default_tools_env_json TEXT",
				)
				.run();
			const accounts = await this.#db
				.prepare(`SELECT id FROM cadmus_accounts`)
				.all<{ id: string }>();
			const now = Date.now();
			for (const account of accounts.results) {
				await this.#seedJustBashDefault(account.id, now);
				await this.#db
					.prepare(
						`UPDATE cadmus_accounts
             SET default_tools_env_json = ?1
             WHERE id = ?2 AND default_tools_env_json IS NULL`,
					)
					.bind(JSON.stringify({ envId: "jb_default" }), account.id)
					.run();
			}
		}

		this.#initialized = true;
	}

	async #seedJustBashDefault(accountId: string, now: number): Promise<void> {
		await this.#db
			.prepare(
				`INSERT OR IGNORE INTO cadmus_tools_envs (
          account_id, env_id, kind, label, workspace_path, persist,
          confine_to_workspace, shared_workspace, secret_id, updated_at
        ) VALUES (?1, 'jb_default', 'just-bash', 'Default just-bash', NULL, 1, 1, 0, NULL, ?2)`,
			)
			.bind(accountId, now)
			.run();
	}

	async resolveToken(
		rawToken: string,
	): Promise<AuthenticatedIdentity | undefined> {
		await this.initialize();
		const tokenHash = await sha256Hex(rawToken);
		const row = await this.#db
			.prepare(
				`SELECT t.user_id, t.account_id, m.role
         FROM cadmus_auth_tokens t
         JOIN cadmus_account_members m
           ON m.account_id = t.account_id AND m.user_id = t.user_id
         WHERE t.token_hash = ?1`,
			)
			.bind(tokenHash)
			.first<{
				user_id: string;
				account_id: string;
				role: "owner" | "member";
			}>();
		if (!row) return undefined;
		return {
			userId: row.user_id,
			accountId: row.account_id,
			role: row.role,
		};
	}

	async ensureAccountAndUser(input: {
		accountId: string;
		userId: string;
		accountName?: string;
		userName?: string;
		role?: "owner" | "member";
		timezone?: string;
	}): Promise<AccountRecord> {
		await this.initialize();
		const now = Date.now();
		const accountName = input.accountName ?? input.accountId;
		const userName = input.userName ?? input.userId;
		const role = input.role ?? "owner";
		const timezone = input.timezone ?? this.#defaultTimezone;

		const inserted = await this.#db
			.prepare(
				`INSERT OR IGNORE INTO cadmus_accounts (id, name, timezone, created_at) VALUES (?1, ?2, ?3, ?4)`,
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
					`INSERT OR IGNORE INTO cadmus_account_members (account_id, user_id, role, created_at) VALUES (?1, ?2, ?3, ?4)`,
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
				`SELECT account_id, user_id, role, created_at
         FROM cadmus_account_members
         WHERE account_id = ?1
         ORDER BY created_at ASC, user_id ASC`,
			)
			.bind(accountId)
			.all<{
				account_id: string;
				user_id: string;
				role: "owner" | "member";
				created_at: number;
			}>();
		return results.map((r) => ({
			accountId: r.account_id,
			userId: r.user_id,
			role: r.role,
			createdAt: r.created_at,
		}));
	}

	async addMember(input: {
		accountId: string;
		userId: string;
		name?: string;
		email?: string;
		role?: "owner" | "member";
		rawToken?: string;
	}): Promise<AccountMember> {
		await this.initialize();
		const now = Date.now();
		const role = input.role ?? "member";
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
					`INSERT INTO cadmus_account_members (account_id, user_id, role, created_at)
           VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(account_id, user_id) DO UPDATE SET role = excluded.role`,
				)
				.bind(input.accountId, input.userId, role, now),
		];

		if (input.rawToken) {
			const tokenHash = await sha256Hex(input.rawToken);
			statements.push(
				this.#db
					.prepare(
						`INSERT OR REPLACE INTO cadmus_auth_tokens (token_hash, user_id, account_id, label, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)`,
					)
					.bind(tokenHash, input.userId, input.accountId, "member-token", now),
			);
		}

		await this.#db.batch(statements);
		return {
			accountId: input.accountId,
			userId: input.userId,
			role,
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
				`SELECT account_id, family_id, name, do_name, timezone, harvest_delay_ms, created_at
         FROM cadmus_families
         WHERE account_id = ?1
         ORDER BY created_at ASC, family_id ASC`,
			)
			.bind(accountId)
			.all<{
				account_id: string;
				family_id: string;
				name: string;
				do_name: string;
				timezone: string;
				harvest_delay_ms: number;
				created_at: number;
			}>();
		return results.map(toFamilyRecord);
	}

	async getFamily(
		accountId: string,
		familyId: string,
	): Promise<FamilyRecord | undefined> {
		await this.initialize();
		const row = await this.#db
			.prepare(
				`SELECT account_id, family_id, name, do_name, timezone, harvest_delay_ms, created_at
         FROM cadmus_families
         WHERE account_id = ?1 AND family_id = ?2`,
			)
			.bind(accountId, familyId)
			.first<{
				account_id: string;
				family_id: string;
				name: string;
				do_name: string;
				timezone: string;
				harvest_delay_ms: number;
				created_at: number;
			}>();
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
		return {
			accountId,
			familyId,
			name: input.name.trim(),
			doName,
			timezone,
			harvestDelayMs,
			createdAt: now,
		};
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
		await this.#db
			.prepare(
				`UPDATE cadmus_families
         SET name = ?1, timezone = ?2, harvest_delay_ms = ?3
         WHERE account_id = ?4 AND family_id = ?5`,
			)
			.bind(nextName, nextTz, nextDelay, accountId, familyId)
			.run();
		return {
			...existing,
			name: nextName,
			timezone: nextTz,
			harvestDelayMs: nextDelay,
		};
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
		return true;
	}

	async listToolsEnvs(accountId: string): Promise<StoredToolsEnv[]> {
		await this.initialize();
		const { results } = await this.#db
			.prepare(
				`SELECT env_id, kind, label, workspace_path, persist, confine_to_workspace,
                shared_workspace, secret_id, secret_missing, updated_at
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
                shared_workspace, secret_id, secret_missing, updated_at
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
			sharedWorkspace: boolean;
			workspacePath?: string;
			secretId?: string;
		},
	): Promise<StoredToolsEnv> {
		await this.initialize();
		const now = Date.now();
		await this.#db
			.prepare(
				`INSERT INTO cadmus_tools_envs (
          account_id, env_id, kind, label, workspace_path, persist,
          confine_to_workspace, shared_workspace, secret_id, secret_missing, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10)`,
			)
			.bind(
				accountId,
				input.envId,
				input.kind,
				input.label ?? null,
				input.workspacePath ?? null,
				input.persist ? 1 : 0,
				input.confineToWorkspace ? 1 : 0,
				input.sharedWorkspace ? 1 : 0,
				input.secretId ?? null,
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
			sharedWorkspace?: boolean;
			workspacePath?: string;
			secretId?: string;
			secretMissing?: boolean;
		},
	): Promise<StoredToolsEnv | undefined> {
		await this.initialize();
		const existing = await this.getToolsEnv(accountId, envId);
		if (!existing) return undefined;
		const label =
			patch.label !== undefined ? patch.label : (existing.label ?? null);
		const persist = patch.persist ?? existing.persist;
		const confine = patch.confineToWorkspace ?? existing.confineToWorkspace;
		const shared = patch.sharedWorkspace ?? existing.sharedWorkspace;
		const workspace =
			patch.workspacePath !== undefined
				? patch.workspacePath
				: (existing.workspacePath ?? null);
		const secret =
			patch.secretId !== undefined
				? patch.secretId
				: (existing.secretId ?? null);
		const secretMissing =
			patch.secretMissing !== undefined
				? patch.secretMissing
				: Boolean(existing.secretMissing);
		await this.#db
			.prepare(
				`UPDATE cadmus_tools_envs
         SET label = ?1, persist = ?2, confine_to_workspace = ?3,
             shared_workspace = ?4, workspace_path = ?5, secret_id = ?6,
             secret_missing = ?7, updated_at = ?8
         WHERE account_id = ?9 AND env_id = ?10`,
			)
			.bind(
				label,
				persist ? 1 : 0,
				confine ? 1 : 0,
				shared ? 1 : 0,
				workspace,
				secret,
				secretMissing ? 1 : 0,
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

	async listToolsEnvSecrets(accountId: string): Promise<ToolsEnvSecretMeta[]> {
		await this.initialize();
		const { results } = await this.#db
			.prepare(
				`SELECT secret_id, label, kind, updated_at
         FROM cadmus_tools_env_secrets
         WHERE account_id = ?1
         ORDER BY updated_at ASC, secret_id ASC`,
			)
			.bind(accountId)
			.all<ToolsEnvSecretSqlRow>();
		return results.map(mapToolsEnvSecret);
	}

	async getToolsEnvSecretMeta(
		accountId: string,
		secretId: string,
	): Promise<ToolsEnvSecretMeta | undefined> {
		await this.initialize();
		const row = await this.#db
			.prepare(
				`SELECT secret_id, label, kind, updated_at
         FROM cadmus_tools_env_secrets
         WHERE account_id = ?1 AND secret_id = ?2`,
			)
			.bind(accountId, secretId)
			.first<ToolsEnvSecretSqlRow>();
		return row ? mapToolsEnvSecret(row) : undefined;
	}

	async setToolsEnvSecret(
		accountId: string,
		input?: { label?: string },
	): Promise<{ secret: ToolsEnvSecretMeta; token: string }> {
		await this.initialize();
		const token = mintDaemonToken();
		const tokenHash = await sha256Hex(token);
		const { ivHex, cipherHex } = await encryptJson(
			this.#encryptionKey,
			accountId,
			{ token },
		);
		const secretId = `hs_${crypto.randomUUID()}`;
		const now = Date.now();
		const label = input?.label?.trim() ? input.label.trim() : null;
		await this.#db
			.prepare(
				`INSERT INTO cadmus_tools_env_secrets (
          account_id, secret_id, label, kind, token_hash, iv_hex, cipher_hex, updated_at
        ) VALUES (?1, ?2, ?3, 'daemon_token', ?4, ?5, ?6, ?7)`,
			)
			.bind(accountId, secretId, label, tokenHash, ivHex, cipherHex, now)
			.run();
		const secret = await this.getToolsEnvSecretMeta(accountId, secretId);
		if (!secret) {
			throw new Error(`Failed to store tools env secret '${secretId}'`);
		}
		return { secret, token };
	}

	async getToolsEnvSecret(
		accountId: string,
		secretId: string,
	): Promise<{ token: string } | undefined> {
		await this.initialize();
		const row = await this.#db
			.prepare(
				`SELECT iv_hex, cipher_hex
         FROM cadmus_tools_env_secrets
         WHERE account_id = ?1 AND secret_id = ?2`,
			)
			.bind(accountId, secretId)
			.first<{ iv_hex: string; cipher_hex: string }>();
		if (!row) return undefined;
		return decryptJson<{ token: string }>(
			this.#encryptionKey,
			accountId,
			row.iv_hex,
			row.cipher_hex,
		);
	}

	async deleteToolsEnvSecret(
		accountId: string,
		secretId: string,
	): Promise<{
		deleted: boolean;
		flaggedEnvIds: string[];
		clearedDefaultEnvId: string | null;
	}> {
		await this.initialize();
		const existing = await this.getToolsEnvSecretMeta(accountId, secretId);
		if (!existing) {
			return { deleted: false, flaggedEnvIds: [], clearedDefaultEnvId: null };
		}
		const named = await this.#db
			.prepare(
				`SELECT env_id FROM cadmus_tools_envs
         WHERE account_id = ?1 AND secret_id = ?2 AND kind = 'local-daemon'`,
			)
			.bind(accountId, secretId)
			.all<{ env_id: string }>();
		const flaggedEnvIds = named.results.map((row) => row.env_id);
		if (flaggedEnvIds.length > 0) {
			await this.#db
				.prepare(
					`UPDATE cadmus_tools_envs
           SET secret_missing = 1, updated_at = ?1
           WHERE account_id = ?2 AND secret_id = ?3 AND kind = 'local-daemon'`,
				)
				.bind(Date.now(), accountId, secretId)
				.run();
		}
		await this.#db
			.prepare(
				`DELETE FROM cadmus_tools_env_secrets
         WHERE account_id = ?1 AND secret_id = ?2`,
			)
			.bind(accountId, secretId)
			.run();
		const account = await this.getAccount(accountId);
		const defaultId = account?.defaultToolsEnv?.envId ?? null;
		let clearedDefaultEnvId: string | null = null;
		if (defaultId && flaggedEnvIds.includes(defaultId)) {
			const updateRes = await this.#db
				.prepare(
					`UPDATE cadmus_accounts
           SET default_tools_env_json = NULL
           WHERE id = ?1 AND json_extract(default_tools_env_json, '$.envId') = ?2`,
				)
				.bind(accountId, defaultId)
				.run();
			if ((updateRes.meta?.changes ?? 0) > 0) {
				clearedDefaultEnvId = defaultId;
			}
		}
		return { deleted: true, flaggedEnvIds, clearedDefaultEnvId };
	}

	async resolveToolsEnvDaemonToken(
		tokenHash: string,
	): Promise<{ accountId: string; secretId: string } | undefined> {
		await this.initialize();
		const row = await this.#db
			.prepare(
				`SELECT account_id, secret_id
         FROM cadmus_tools_env_secrets
         WHERE token_hash = ?1 AND kind = 'daemon_token'`,
			)
			.bind(tokenHash)
			.first<{ account_id: string; secret_id: string }>();
		if (!row) return undefined;
		return { accountId: row.account_id, secretId: row.secret_id };
	}
}

function mintDaemonToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	const hex = Array.from(bytes)
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	return `cadmus_dt_${hex}`;
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
	shared_workspace: number;
	secret_id: string | null;
	secret_missing: number | null;
	updated_at: number;
}

function mapToolsEnv(row: ToolsEnvSqlRow): StoredToolsEnv {
	const record: StoredToolsEnv = {
		envId: row.env_id,
		kind: row.kind === "local-daemon" ? "local-daemon" : "just-bash",
		persist: row.persist !== 0,
		confineToWorkspace: row.confine_to_workspace !== 0,
		sharedWorkspace: row.shared_workspace !== 0,
		updatedAt: Number(row.updated_at),
	};
	if (row.label) record.label = row.label;
	if (row.workspace_path) record.workspacePath = row.workspace_path;
	if (row.secret_id) record.secretId = row.secret_id;
	if (row.secret_missing) record.secretMissing = true;
	return record;
}

interface ToolsEnvSecretSqlRow {
	secret_id: string;
	label: string | null;
	kind: string;
	updated_at: number;
}

function mapToolsEnvSecret(row: ToolsEnvSecretSqlRow): ToolsEnvSecretMeta {
	const record: ToolsEnvSecretMeta = {
		secretId: row.secret_id,
		kind: "daemon_token",
		updatedAt: Number(row.updated_at),
	};
	if (row.label) record.label = row.label;
	return record;
}

function toFamilyRecord(row: {
	account_id: string;
	family_id: string;
	name: string;
	do_name: string;
	timezone: string;
	harvest_delay_ms: number;
	created_at: number;
}): FamilyRecord {
	return {
		accountId: row.account_id,
		familyId: row.family_id,
		name: row.name,
		doName: row.do_name,
		timezone: row.timezone,
		harvestDelayMs: row.harvest_delay_ms,
		createdAt: row.created_at,
	};
}
