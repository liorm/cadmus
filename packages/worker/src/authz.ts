import {
	GRANTS,
	type Grant,
	isGrant,
	normalizeRole,
	ROLE_GRANTS,
	type Role,
} from "@cadmus/contract/grants";
import { fromBase64UrlString, toBase64Url } from "./base64url.js";
import { getCommandGrant } from "./protocol/rest.js";
import { ProtocolValidationError } from "./protocol.js";

/**
 * Who is acting, as resolved at the edge from the request credential.
 * Live HTTP auth always sets a user session. `grants` stays so a principal
 * that still carries a token grant list is clamped and refused for session
 * management.
 */
export interface Principal {
	/** What kind of credential authenticated the request. */
	kind: "user" | "token" | "daemon";
	userId?: string;
	accountId: string;
	role: Role;
	/** Cadmus session that authenticated the request, when there is one. */
	sessionId?: string;
	/**
	 * Leftover token grant list. Live auth does not set this. When it is set,
	 * grants are clamped to the role and session management is refused.
	 */
	grants?: Grant[];
	/** User sessions: epoch ms when admin mode ends, while it is on. */
	elevatedUntil?: number;
	/** Short role-choice session. */
	provisional?: boolean;
	/** Unused by live auth. Kept so an old principal attachment still parses. */
	credential?: string;
}

/**
 * Request caller forwarded from edge authentication.
 * `requireOwner` is the only role gate today and only tools-env deregister
 * calls it; issue #3 phase 2 absorbs it into grant-based authorization.
 */
export interface CallerMeta {
	role?: Role;
	userId?: string;
	accountId?: string;
	kind?: Principal["kind"];
	sessionId?: string;
	grants?: Grant[];
	elevatedUntil?: number;
	provisional?: boolean;
	credential?: string;
}

/**
 * Header set by the edge from the authenticated principal (base64url JSON).
 * It is the only identity the Family DO trusts. The edge strips every
 * client-sent `x-cadmus-*`, `x-user-id`, `x-account-id` and `x-family-id`
 * header before forwarding, so clients cannot set it.
 */
export const PRINCIPAL_HEADER = "X-Cadmus-Principal";

/** Client headers that name an identity or routing scope. Dropped at the edge. */
const IDENTITY_HEADERS = ["x-user-id", "x-account-id", "x-family-id"];

export function isClientIdentityHeader(name: string): boolean {
	const lower = name.toLowerCase();
	return lower.startsWith("x-cadmus-") || IDENTITY_HEADERS.includes(lower);
}

export function encodePrincipal(principal: Principal): string {
	return toBase64Url(JSON.stringify(principal));
}

export function callerMetaFromPrincipal(value: unknown): CallerMeta {
	if (!value || typeof value !== "object") return {};
	const raw = value as Record<string, unknown>;
	const meta: CallerMeta = {};
	const role = normalizeRole(raw.role);
	if (role) meta.role = role;
	if (typeof raw.userId === "string" && raw.userId) meta.userId = raw.userId;
	if (typeof raw.accountId === "string" && raw.accountId) {
		meta.accountId = raw.accountId;
	}
	if (typeof raw.sessionId === "string" && raw.sessionId) {
		meta.sessionId = raw.sessionId;
	}
	if (typeof raw.credential === "string" && raw.credential) {
		meta.credential = raw.credential;
	}
	if (typeof raw.elevatedUntil === "number" && raw.elevatedUntil > 0) {
		meta.elevatedUntil = raw.elevatedUntil;
	}
	if (raw.provisional === true) meta.provisional = true;
	if (Array.isArray(raw.grants)) {
		meta.grants = raw.grants.filter(isGrant);
	}
	if (raw.kind === "user" || raw.kind === "token" || raw.kind === "daemon") {
		meta.kind = raw.kind;
	}
	return meta;
}

export function callerMetaFromHeader(value: string | null): CallerMeta {
	if (!value) return {};
	try {
		return callerMetaFromPrincipal(JSON.parse(fromBase64UrlString(value)));
	} catch {
		return {};
	}
}

export function callerMetaFromAttachment(value: unknown): CallerMeta {
	return callerMetaFromPrincipal(value);
}

/** Grants the caller holds: the role's, clamped when a leftover grant list is set. */
export function callerGrants(caller: CallerMeta): readonly Grant[] {
	const fromRole: readonly Grant[] = caller.role
		? ROLE_GRANTS[caller.role]
		: [];
	if (!caller.grants) return fromRole;
	return caller.grants.filter((g) => fromRole.includes(g));
}

/**
 * The single authorization check for every transport (/api, /rpc, /ws).
 * A command is allowed when the principal's role holds the grant the command
 * schema declares. A command with no known grant is denied.
 *
 * A grant flagged `elevation` also needs admin mode for a user session.
 * A principal that still carries a grant list is not asked to elevate again;
 * those grants are the only ones it holds.
 */
export function authorize(caller: CallerMeta, commandType: string): Grant {
	const grant = getCommandGrant(commandType) as Grant | undefined;
	if (!grant) {
		throw new ProtocolValidationError(
			`Command '${commandType}' declares no grant`,
			"forbidden",
		);
	}
	const held = callerGrants(caller);
	if (!held.includes(grant)) {
		throw new ProtocolValidationError(
			`Role '${caller.role ?? "none"}' does not hold grant '${grant}' required by '${commandType}'`,
			"forbidden",
		);
	}
	if (needsElevation(grant, caller) && !isElevated(caller)) {
		throw new ProtocolValidationError(
			`'${commandType}' needs admin mode. Turn it on first`,
			"elevation_required",
		);
	}
	return grant;
}

/** True when `grant` must be exercised in admin mode by this caller. */
export function needsElevation(grant: Grant, caller: CallerMeta): boolean {
	return GRANTS[grant].elevation && !!caller.sessionId && !caller.grants;
}

/**
 * True when this use of `grant` is an elevated use that must be audited: a user
 * session in admin mode, or a principal whose grant list includes an elevated
 * grant.
 */
export function isElevatedUse(grant: Grant, caller: CallerMeta): boolean {
	if (!caller.sessionId) return false;
	return (
		needsElevation(grant, caller) ||
		(!!caller.grants && GRANTS[grant].elevation)
	);
}

/** True while the caller's session is in admin mode. */
export function isElevated(caller: CallerMeta, now = Date.now()): boolean {
	return caller.elevatedUntil !== undefined && caller.elevatedUntil > now;
}

/**
 * For handlers that branch on an elevated grant the command schema does not
 * declare (the command's own grant is not elevated). Refuses a user session
 * that is not in admin mode, the same way authorize() does.
 */
export function requireElevationFor(
	grant: Grant,
	caller: CallerMeta,
	commandType: string,
): void {
	if (needsElevation(grant, caller) && !isElevated(caller)) {
		throw new ProtocolValidationError(
			`'${commandType}' needs admin mode for this use. Turn it on first`,
			"elevation_required",
		);
	}
}

/** Session-bound commands need a Cadmus user session. */
export function requireSession(caller: CallerMeta): string {
	if (!caller.sessionId || !caller.userId) {
		throw new ProtocolValidationError(
			"This command needs a signed-in session",
			"forbidden",
		);
	}
	// A principal that still carries a grant list acts for one account and
	// must not manage the user's sessions or login methods.
	if (caller.grants) {
		throw new ProtocolValidationError(
			"API tokens cannot manage sessions or login methods",
			"forbidden",
		);
	}
	return caller.sessionId;
}
