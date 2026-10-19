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
	initialize(): Promise<void>;

	// Auth & Accounts
	resolveToken(rawToken: string): Promise<AuthenticatedIdentity | undefined>;
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
		patch: { name?: string; timezone?: string },
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
