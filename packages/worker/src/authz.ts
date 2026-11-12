import {
	type Grant,
	normalizeRole,
	ROLE_GRANTS,
	type Role,
} from "@cadmus/contract/grants";
import { getCommandGrant } from "./protocol/rest.js";
import { ProtocolValidationError } from "./protocol.js";

/**
 * Who is acting, as resolved at the edge from the request credential.
 * Issue #3 phase 1: built from today's credentials (master secret and stored
 * member tokens). Later phases add sessions and grants.
 */
export interface Principal {
	/** What kind of credential authenticated the request. */
	kind: "user" | "token" | "daemon";
	userId?: string;
	accountId: string;
	role: Role;
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

function toBase64Url(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
	const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
	return new TextDecoder().decode(bytes);
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
	if (raw.kind === "user" || raw.kind === "token" || raw.kind === "daemon") {
		meta.kind = raw.kind;
	}
	return meta;
}

export function callerMetaFromHeader(value: string | null): CallerMeta {
	if (!value) return {};
	try {
		return callerMetaFromPrincipal(JSON.parse(fromBase64Url(value)));
	} catch {
		return {};
	}
}

export function callerMetaFromAttachment(value: unknown): CallerMeta {
	return callerMetaFromPrincipal(value);
}

/**
 * The single authorization check for every transport (/api, /rpc, /ws).
 * A command is allowed when the principal's role holds the grant the command
 * schema declares. A command with no known grant is denied.
 *
 * Elevation (admin mode) is not enforced yet: grants flagged `elevation` are
 * checked like the rest until phase 6 adds the `elevation_required` result.
 */
export function authorize(caller: CallerMeta, commandType: string): Grant {
	const grant = getCommandGrant(commandType) as Grant | undefined;
	if (!grant) {
		throw new ProtocolValidationError(
			`Command '${commandType}' declares no grant`,
			"forbidden",
		);
	}
	const held: readonly Grant[] = caller.role ? ROLE_GRANTS[caller.role] : [];
	if (!held.includes(grant)) {
		throw new ProtocolValidationError(
			`Role '${caller.role ?? "none"}' does not hold grant '${grant}' required by '${commandType}'`,
			"forbidden",
		);
	}
	return grant;
}
