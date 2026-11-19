import { type Static, Type } from "typebox";

/**
 * Protocol and `/api` error codes. `ProtocolError.code` stays an open string
 * so a new code still serializes; this list is the reviewed set clients and
 * docs agree on. HTTP status for each code is declared in `rest-rule.ts`.
 */
export const ERROR_CODES = [
	"unauthorized",
	"query_token_not_allowed",
	"header_required",
	"forbidden",
	"elevation_required",
	"not_found",
	"family_not_found",
	"cas_conflict",
	"conflict",
	"role_unchanged",
	"command_failed",
	"invalid_command",
	"invalid_json",
	"invalid_frame",
	"frame_too_large",
	"method_not_allowed",
	"unsupported_command",
	"unsupported_kind",
	"oauth_failed",
	"invalid_tools_env",
	"confinement_required",
	"tools_env_on_without_config",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ErrorCodeSchema = Type.Union(
	ERROR_CODES.map((code) => Type.Literal(code)),
	{
		description:
			"Machine-readable protocol error code. CAS conflicts use cas_conflict (HTTP 409). /api auth failures use unauthorized, query_token_not_allowed, or header_required (HTTP 401).",
	},
);

/** REST and auth failure body: `{ error: { code, message } }`. */
export const ApiErrorEnvelopeSchema = Type.Object(
	{
		error: Type.Object(
			{
				code: ErrorCodeSchema,
				message: Type.String({
					description: "Human-readable explanation of the failure.",
				}),
			},
			{ description: "Error object." },
		),
	},
	{
		description:
			"JSON error envelope returned by /api for auth failures, validation failures, missing paths, method mismatches, and failed commands.",
	},
);

export type ApiErrorEnvelope = Static<typeof ApiErrorEnvelopeSchema>;
