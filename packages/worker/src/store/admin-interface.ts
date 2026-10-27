import type { Credential } from "@earendil-works/pi-ai";
import type {
	AccountMember,
	AccountRecord,
	CredentialInput,
	CredentialSummary,
	FamilyRecord,
} from "../protocol.js";

export type { AccountRecord };

export interface AuthenticatedIdentity {
	userId: string;
	accountId: string;
	role: "owner" | "member";
}

export interface UserRecord {
	id: string;
	name: string;
	email?: string;
	createdAt: number;
}

export interface StoredToolsEnv {
	envId: string;
	kind: "just-bash" | "local-daemon";
	label?: string;
	persist: boolean;
	confineToWorkspace: boolean;
	sharedWorkspace: boolean;
	workspacePath?: string;
	secretId?: string;
	/** Set when the pairing secret this row named was deleted. */
	secretMissing?: boolean;
	updatedAt: number;
}

export interface ToolsEnvSecretMeta {
	secretId: string;
	label?: string;
	kind: "daemon_token";
	updatedAt: number;
}

export interface FamilySettingsPatch {
	name?: string;
	timezone?: string;
	harvestDelayMs?: number;
}

/**
 * Global administrative store (backed by Cloudflare D1 `CADMUS_ADMIN_DB`).
 * Owns cross-family, account-level entities: users, auth tokens, accounts,
 * user-to-account memberships, account-scoped encrypted BYOK credentials,
 * and the Bot Families catalog (`account_id <-> family_id <-> do_name`).
 */
export interface AdminStore {
	initialize(options?: { force?: boolean }): Promise<void>;

	// Auth & Accounts
	resolveToken(rawToken: string): Promise<AuthenticatedIdentity | undefined>;
	revokeToken(rawToken: string): Promise<boolean>;
	revokeTokenByHash(tokenHash: string): Promise<boolean>;
	ensureAccountAndUser(input: {
		accountId: string;
		userId: string;
		accountName?: string;
		userName?: string;
		role?: "owner" | "member";
		timezone?: string;
	}): Promise<AccountRecord>;
	getAccount(accountId: string): Promise<AccountRecord | undefined>;
	updateAccount(
		accountId: string,
		patch: {
			name?: string;
			timezone?: string;
			defaultToolsEnv?: { envId: string } | null;
		},
	): Promise<AccountRecord>;
	listMembers(accountId: string): Promise<AccountMember[]>;
	addMember(input: {
		accountId: string;
		userId: string;
		name?: string;
		email?: string;
		role?: "owner" | "member";
		rawToken?: string;
	}): Promise<AccountMember>;

	// Account-level Encrypted BYOK Credentials
	listCredentials(accountId: string): Promise<CredentialSummary[]>;
	getCredential(
		accountId: string,
		providerId: string,
	): Promise<Credential | undefined>;
	getAllCredentials(accountId: string): Promise<Record<string, Credential>>;
	setCredential(
		accountId: string,
		providerId: string,
		input: CredentialInput | Credential,
	): Promise<CredentialSummary>;
	deleteCredential(accountId: string, providerId: string): Promise<boolean>;

	// Account tools env catalog
	listToolsEnvs(accountId: string): Promise<StoredToolsEnv[]>;
	getToolsEnv(
		accountId: string,
		envId: string,
	): Promise<StoredToolsEnv | undefined>;
	createToolsEnv(
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
	): Promise<StoredToolsEnv>;
	updateToolsEnv(
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
	): Promise<StoredToolsEnv | undefined>;
	deleteToolsEnv(accountId: string, envId: string): Promise<boolean>;

	/** Metadata only. Never plaintext, iv, or ciphertext. */
	listToolsEnvSecrets(accountId: string): Promise<ToolsEnvSecretMeta[]>;
	getToolsEnvSecretMeta(
		accountId: string,
		secretId: string,
	): Promise<ToolsEnvSecretMeta | undefined>;
	/**
	 * Mint `cadmus_dt_` + 64 hex, store SHA-256 and AES-GCM `{ token }`.
	 * The plaintext is returned once and is not accepted from the caller.
	 */
	setToolsEnvSecret(
		accountId: string,
		input?: { label?: string },
	): Promise<{ secret: ToolsEnvSecretMeta; token: string }>;
	/** Decrypt. Not a client RPC and not used on the daemon upgrade path. */
	getToolsEnvSecret(
		accountId: string,
		secretId: string,
	): Promise<{ token: string } | undefined>;
	/**
	 * Remove the secret, flag daemon env rows that named it (`secret_missing`),
	 * and clear `defaultToolsEnv` only when it still names one of those envs.
	 */
	deleteToolsEnvSecret(
		accountId: string,
		secretId: string,
	): Promise<{
		deleted: boolean;
		flaggedEnvIds: string[];
		clearedDefaultEnvId: string | null;
	}>;
	resolveToolsEnvDaemonToken(
		tokenHash: string,
	): Promise<{ accountId: string; secretId: string } | undefined>;

	// Bot Families Registry
	listFamilies(accountId: string): Promise<FamilyRecord[]>;
	getFamily(
		accountId: string,
		familyId: string,
	): Promise<FamilyRecord | undefined>;
	ensureFamily(
		accountId: string,
		familyId: string,
		defaults?: { name?: string; timezone?: string; harvestDelayMs?: number },
	): Promise<FamilyRecord>;
	createFamily(
		accountId: string,
		input: {
			familyId?: string;
			name: string;
			timezone?: string;
			harvestDelayMs?: number;
		},
	): Promise<FamilyRecord>;
	updateFamily(
		accountId: string,
		familyId: string,
		patch: FamilySettingsPatch,
	): Promise<FamilyRecord | undefined>;
	deleteFamily(accountId: string, familyId: string): Promise<boolean>;
}
