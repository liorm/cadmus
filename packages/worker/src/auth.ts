import { getLogger } from "./log.js";
import type {
	AdminStore,
	AuthenticatedIdentity,
} from "./store/admin-interface.js";
import type { Env } from "./types.js";

export interface ResolvedRequestScope extends AuthenticatedIdentity {
	familyId: string;
}

/**
 * Which credential transports `authenticateRequest` may read.
 *
 * Transport parsing still sees the header, the `cadmus_session` cookie and
 * `?token=`. `authenticateRequest` then refuses the cookie and `?token=` for
 * every credential. `/ws` and `/events` open with a single-use ticket from
 * `auth.ticket`. `/api` rejects the cookie and query forms up front
 * (`query_token_not_allowed`, `header_required`).
 */
export interface AuthenticateRequestOptions {
	allowQueryToken?: boolean;
	allowCookie?: boolean;
}

export type AuthDenialCode =
	| "unauthorized"
	| "query_token_not_allowed"
	| "header_required";

export type AuthenticateRequestResult =
	| { ok: true; scope: ResolvedRequestScope }
	| { ok: false; code: AuthDenialCode; message: string };

const UNAUTHORIZED_MESSAGE = "Missing or invalid authentication token";
const QUERY_TOKEN_MESSAGE =
	"The token query parameter is not allowed. Send Authorization: Bearer instead.";
const HEADER_REQUIRED_MESSAGE =
	"Authorization: Bearer token is required. Session cookies are not accepted.";

export function bearerToken(request: Request): string | undefined {
	const authHeader = request.headers.get("authorization");
	if (!authHeader) return undefined;
	const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
	const token = match?.[1]?.trim();
	return token ? token : undefined;
}

/**
 * One named cookie from the request `Cookie` header.
 *
 * `decode` is only for the retired `cadmus_session` credential, which clients
 * percent-encode. OAuth and refresh cookies are written raw and are returned
 * as written, including `""`. A decoded empty session value is treated as
 * missing. A malformed percent-escape is skipped (the next same-named cookie
 * can still match) so a bad `cadmus_session` is absent instead of throwing.
 */
export function readCookie(
	request: Request,
	name: string,
	options?: { decode?: boolean },
): string | undefined {
	const header = request.headers.get("cookie");
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key !== name) continue;
		const raw = rest.join("=");
		if (!options?.decode) return raw;
		if (rest.length === 0) continue;
		let value: string;
		try {
			value = decodeURIComponent(raw.trim());
		} catch (error) {
			if (error instanceof URIError) continue;
			throw error;
		}
		if (value.length > 0) return value;
	}
	return undefined;
}

function sessionCookieToken(request: Request): string | undefined {
	return readCookie(request, "cadmus_session", { decode: true });
}

/**
 * True when the URL has a `token` query parameter.
 * The value is not read, so it cannot be logged from this check.
 */
export function hasQueryToken(request: Request): boolean {
	return new URL(request.url).searchParams.has("token");
}

export function extractRawToken(
	request: Request,
	options: AuthenticateRequestOptions = {},
): string | undefined {
	const headerToken = bearerToken(request);
	if (headerToken) return headerToken;
	if (options.allowCookie !== false) {
		const cookieToken = sessionCookieToken(request);
		if (cookieToken) return cookieToken;
	}
	if (options.allowQueryToken !== false) {
		const queryToken = new URL(request.url).searchParams.get("token")?.trim();
		if (queryToken) return queryToken;
	}
	return undefined;
}

/**
 * Authenticates every inbound HTTP / WebSocket request at the Worker Edge.
 * Anonymous and invalid credentials resolve as `{ ok: false, code: "unauthorized" }`
 * (401). `/api` may also deny with `query_token_not_allowed` or `header_required`.
 *
 * A bearer is a session access token (`cad_at_`). Anything else is 401.
 * There is no API token, no legacy member token, and no shared-secret bearer.
 *
 * `options.allowQueryToken` / `options.allowCookie` default to true. `/api` sets
 * both to false: a `token` query parameter is rejected before it is read, and a
 * session cookie is not a credential (`header_required` when it is the only one).
 */
export async function authenticateRequest(
	request: Request,
	_env: Env,
	adminStore: AdminStore,
	options: AuthenticateRequestOptions = {},
): Promise<AuthenticateRequestResult> {
	const allowQueryToken = options.allowQueryToken !== false;
	const allowCookie = options.allowCookie !== false;
	if (!allowQueryToken && hasQueryToken(request)) {
		const path = new URL(request.url).pathname;
		getLogger().warn("api credential transport rejected", {
			code: "query_token_not_allowed",
			method: request.method,
			path,
		});
		return {
			ok: false,
			code: "query_token_not_allowed",
			message: QUERY_TOKEN_MESSAGE,
		};
	}

	const ticketParam = new URL(request.url).searchParams.get("ticket");
	const ticketPath = new URL(request.url).pathname;
	if (ticketParam && (ticketPath === "/ws" || ticketPath === "/events")) {
		const target = ticketPath === "/events" ? "events" : "ws";
		const identity = await adminStore.consumeTicket(ticketParam, target);
		if (!identity) {
			return { ok: false, code: "unauthorized", message: UNAUTHORIZED_MESSAGE };
		}
		const familyParam =
			request.headers.get("x-cadmus-family-id")?.trim() ||
			new URL(request.url).searchParams.get("familyId")?.trim() ||
			"default";
		return {
			ok: true,
			scope: {
				accountId: identity.accountId,
				userId: identity.userId,
				role: identity.role,
				sessionId: identity.sessionId,
				familyId: familyParam,
			},
		};
	}

	const rawToken = extractRawToken(request, {
		allowQueryToken,
		allowCookie,
	});
	if (!rawToken) {
		if (!allowCookie && sessionCookieToken(request)) {
			const path = new URL(request.url).pathname;
			getLogger().warn("api credential transport rejected", {
				code: "header_required",
				method: request.method,
				path,
			});
			return {
				ok: false,
				code: "header_required",
				message: HEADER_REQUIRED_MESSAGE,
			};
		}
		getLogger().debug("auth failed: no token present");
		return {
			ok: false,
			code: "unauthorized",
			message: UNAUTHORIZED_MESSAGE,
		};
	}

	const url = new URL(request.url);
	const requestedFamilyId =
		request.headers.get("x-cadmus-family-id")?.trim() ||
		request.headers.get("x-family-id")?.trim() ||
		url.searchParams.get("familyId")?.trim() ||
		"default";

	// Credential transport. `?token=` and the `cadmus_session` cookie are not
	// credentials. Every credential is accepted from the header only. Streams
	// open with a ticket that a header-authenticated `auth.ticket` call minted.
	const transport: "header" | "cookie" | "query" = bearerToken(request)
		? "header"
		: sessionCookieToken(request)
			? "cookie"
			: "query";
	const rejectTransport = (): AuthenticateRequestResult => {
		getLogger().warn("credential transport rejected", {
			transport,
			method: request.method,
			path: url.pathname,
		});
		return { ok: false, code: "unauthorized", message: UNAUTHORIZED_MESSAGE };
	};

	// Session access tokens are header-only. Streams open with a ticket.
	if (transport !== "header") return rejectTransport();

	if (url.pathname === "/ws" || url.pathname === "/events") {
		getLogger().warn("stream credential rejected: ticket required", {
			method: request.method,
			path: url.pathname,
		});
		return {
			ok: false,
			code: "unauthorized",
			message: UNAUTHORIZED_MESSAGE,
		};
	}

	// Session access tokens are read from D1 on every request, so revocation
	// and suspension take effect immediately. Any other bearer is refused.
	if (!rawToken.startsWith("cad_at_")) {
		getLogger().warn("auth failed: invalid bearer token");
		return {
			ok: false,
			code: "unauthorized",
			message: UNAUTHORIZED_MESSAGE,
		};
	}
	// `x-account-id` selects among the user's own memberships. The store
	// re-checks the live membership, so a foreign or unknown id fails the
	// same way a bad token does.
	const selected = request.headers.get("x-account-id")?.trim() || undefined;
	const session = await adminStore.resolveAccessToken(rawToken, selected);
	if (!session) {
		return { ok: false, code: "unauthorized", message: UNAUTHORIZED_MESSAGE };
	}
	return {
		ok: true,
		scope: {
			accountId: session.accountId,
			userId: session.userId,
			role: session.role,
			sessionId: session.sessionId,
			...(session.elevatedUntil
				? { elevatedUntil: session.elevatedUntil }
				: {}),
			...(session.provisional ? { provisional: true } : {}),
			familyId: requestedFamilyId,
		},
	};
}
