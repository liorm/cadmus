import { ProtocolValidationError } from "./protocol.js";

/**
 * Request caller forwarded from edge authentication.
 * Issue #3 will absorb `requireOwner` into account-wide role enforcement.
 * Until then this is the only gate, and only daemon deregister calls it.
 */
export interface CallerMeta {
	role?: "owner" | "member";
}

/** Header set by the edge from the authenticated membership. Clients cannot override it. */
export const CALLER_ROLE_HEADER = "X-Cadmus-Caller-Role";

export function callerMetaFromHeader(value: string | null): CallerMeta {
	if (value === "owner" || value === "member") return { role: value };
	return {};
}

export function callerMetaFromAttachment(value: unknown): CallerMeta {
	if (!value || typeof value !== "object") return {};
	const role = (value as { role?: unknown }).role;
	if (role === "owner" || role === "member") return { role };
	return {};
}

export function requireOwner(meta: CallerMeta): void {
	if (meta.role !== "owner") {
		throw new ProtocolValidationError(
			"Only account owners can deregister a daemon",
			"forbidden",
		);
	}
}
