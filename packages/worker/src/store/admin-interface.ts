import type { Role } from "@cadmus/contract/grants";
import type { Credential } from "@earendil-works/pi-ai";
import type { LoginIdentity } from "../auth/google.js";
import type {
	AccountMember,
	AccountRecord,
	ConfinementPolicy,
	CredentialInput,
	CredentialSummary,
	FamilyRecord,
	SystemAccountsGetResult,
	SystemMetricsResult,
} from "../protocol.js";
import type {
	DeviceDecisionResult,
	DeviceLoginStart,
	DevicePollResult,
} from "./d1-device-login.js";
import type { LoginResult } from "./d1-login.js";
import type {
	InviteResult,
	InviteSummary,
	MemberChangeResult,
} from "./d1-members.js";
import type {
	CreateSessionInput,
	ElevatedCommandPhase,
	ElevatedOperation,
	LoginMethodSummary,
	MembershipSummary,
	RefreshResult,
	RevokeMethodResult,
	SessionIdentity,
	SessionSummary,
	SessionTokens,
	TicketIdentity,
	TicketTarget,
} from "./d1-sessions.js";
import type {
	SystemAccount,
	SystemAuditEvent,
	SystemMember,
	SystemResult,
} from "./d1-system.js";

export type { AccountRecord };

export interface AuthenticatedIdentity {
	/** Set when a Cadmus session authenticated the request. */
	sessionId?: string;
	userId: string;
	accountId: string;
	role: Role;
	/** User sessions only: epoch ms when admin mode ends, while it is on. */
	elevatedUntil?: number;
	provisional?: boolean;
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
	confinementPolicy?: ConfinementPolicy;
	sharedWorkspace: boolean;
	updatedAt: number;
}

export interface FamilySettingsPatch {
	name?: string;
	timezone?: string;
	harvestDelayMs?: number;
	/** Non-empty bot id sets the Team Leader. null clears it. Omit to leave unchanged. */
	teamLeaderBotId?: string | null;
}

/**
 * Global administrative store (backed by Cloudflare D1 `CADMUS_ADMIN_DB`).
 * Owns cross-family, account-level entities: users, auth tokens, accounts,
 * user-to-account memberships, account-scoped encrypted BYOK credentials,
 * and the Bot Families catalog (`account_id <-> family_id <-> do_name`).
 */
export interface AdminStore {
	inviteMember(input: {
		accountId: string;
		invitedBy: string;
		email: string;
		roles?: Role[];
		ttlMs?: number;
		actorKind?: "user" | "super-admin";
	}): Promise<InviteResult>;
	listInvites(accountId: string): Promise<InviteSummary[]>;
	revokeInvite(input: {
		accountId: string;
		inviteId: string;
		actor: string;
	}): Promise<boolean>;
	updateMemberRole(input: {
		accountId: string;
		userId: string;
		op: "grant" | "revoke";
		role: Role;
		actor: string;
		actorKind?: "user" | "super-admin";
	}): Promise<MemberChangeResult>;
	removeMember(input: {
		accountId: string;
		userId: string;
		actor: string;
		actorKind?: "user" | "super-admin";
	}): Promise<MemberChangeResult>;
	createTicket(
		sessionId: string,
		target: TicketTarget,
		accountId?: string,
	): Promise<{ ticket: string; expiresAt: number }>;
	consumeTicket(
		ticket: string,
		target: TicketTarget,
	): Promise<TicketIdentity | undefined>;
	listSessions(userId: string): Promise<SessionSummary[]>;
	revokeOwnSession(userId: string, sessionId: string): Promise<boolean>;
	revokeOtherSessions(
		userId: string,
		currentSessionId: string,
	): Promise<number>;
	listLoginMethods(userId: string): Promise<LoginMethodSummary[]>;
	/** Name and primary email, when this id is a real user row. */
	userProfile(
		userId: string,
	): Promise<{ name?: string; email?: string } | undefined>;
	listMemberships(userId: string): Promise<MembershipSummary[]>;
	revokeLoginMethod(
		userId: string,
		methodId: string,
	): Promise<RevokeMethodResult>;
	completeLogin(
		identity: LoginIdentity,
		options?: {
			bootstrapEmail?: string;
			userAgent?: string;
			ipCountry?: string;
			freshGoogleAt?: number;
			chooseRole?: boolean;
		},
	): Promise<LoginResult>;
	// Sessions (issue #3 phase 3)
	createSession(input: CreateSessionInput): Promise<SessionTokens>;
	assumeRole(input: {
		rawAccess: string;
		role: Role;
		accountId: string;
		userAgent?: string;
	}): Promise<
		| { ok: true; tokens: SessionTokens }
		| { ok: false; code: "unauthorized" | "forbidden" | "role_unchanged" }
	>;
	resolveAccessToken(
		rawToken: string,
		selectedAccountId?: string,
	): Promise<SessionIdentity | undefined>;
	resolveSession(
		sessionId: string,
		accountId?: string,
	): Promise<SessionIdentity | undefined>;
	rotateRefreshToken(rawRefresh: string): Promise<RefreshResult>;
	startDeviceLogin(input?: {
		now?: number;
		userAgent?: string;
		ipCountry?: string;
	}): Promise<DeviceLoginStart>;
	pollDeviceLogin(
		deviceSecret: string,
		now?: number,
	): Promise<DevicePollResult>;
	approveDeviceLogin(input: {
		deviceCode: string;
		identity: SessionIdentity;
		now?: number;
	}): Promise<DeviceDecisionResult>;
	denyDeviceLogin(
		deviceCode: string,
		now?: number,
	): Promise<DeviceDecisionResult>;
	revokeSession(sessionId: string): Promise<boolean>;
	/** Revokes the session that currently holds this refresh token. Does not rotate it. */
	revokeSessionByRefresh(rawRefresh: string): Promise<boolean>;
	sessionRefusalReason(
		sessionId: string,
		accountId?: string,
	): Promise<"account_suspended" | "user_disabled" | undefined>;
	// System console (issue #3 phase 6b): account records only
	listSystemAccounts(): Promise<SystemAccount[]>;
	listAccountMembers(
		accountId: string,
	): Promise<SystemResult<{ members: SystemMember[] }>>;
	setUserDisabled(input: {
		userId: string;
		disabled: boolean;
		actor: string;
	}): Promise<SystemResult<{ changed: boolean }>>;
	revokeUserSessions(input: {
		userId: string;
		actor: string;
	}): Promise<SystemResult<{ revoked: number }>>;
	createSystemAccount(input: {
		name: string;
		timezone?: string;
		actor: string;
		ownerEmail: string;
	}): Promise<SystemResult<{ account: SystemAccount }>>;
	setSystemAccountStatus(input: {
		accountId: string;
		status: "active" | "suspended";
		actor: string;
	}): Promise<SystemResult<{ account: SystemAccount; changed: boolean }>>;
	renameSystemAccount(input: {
		accountId: string;
		name: string;
		actor: string;
	}): Promise<SystemResult<{ account: SystemAccount; changed: boolean }>>;
	listSystemAudit(input: {
		limit: number;
		accountId?: string;
		before?: number;
		beforeId?: string;
	}): Promise<SystemAuditEvent[]>;
	getSystemMetrics(): Promise<SystemMetricsResult>;
	getSystemAccountDetail(
		accountId: string,
	): Promise<SystemResult<SystemAccountsGetResult>>;
	revokeSystemSession(input: {
		sessionId: string;
		accountId?: string;
		actor: string;
	}): Promise<SystemResult<{ revoked: boolean; sessionId: string }>>;
	listAccountAudit(input: {
		accountId: string;
		limit: number;
		before?: number;
		beforeId?: string;
	}): Promise<SystemAuditEvent[]>;
	startElevation(
		sessionId: string,
		accountId?: string,
	): Promise<number | undefined>;
	endElevation(sessionId: string): Promise<boolean>;
	auditElevatedCommand(
		sessionId: string,
		commandType: string,
		phase: ElevatedCommandPhase,
		operation: ElevatedOperation,
	): Promise<void>;
	initialize(options?: { force?: boolean }): Promise<void>;

	// Auth & Accounts
	ensureAccountAndUser(input: {
		accountId: string;
		userId: string;
		accountName?: string;
		userName?: string;
		role?: Role;
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
		roles?: Role[];
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
			confinementPolicy?: ConfinementPolicy;
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
			confinementPolicy?: ConfinementPolicy;
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
