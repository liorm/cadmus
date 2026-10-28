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
		},
	): Promise<StoredToolsEnv | undefined>;
	deleteToolsEnv(accountId: string, envId: string): Promise<boolean>;

	/**
	 * Store the SHA-256 of a daemon session token on the env row.
	 * The plaintext is returned once by the caller and is not stored.
	 */
	assignToolsEnvDaemonToken(
		accountId: string,
		envId: string,
		tokenHash: string,
		label?: string,
	): Promise<void>;
	clearToolsEnvDaemonToken(accountId: string, envId: string): Promise<void>;
	resolveToolsEnvDaemonToken(
		tokenHash: string,
	): Promise<{ accountId: string; envId: string } | undefined>;

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
