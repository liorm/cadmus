import { type Static, Type } from "typebox";

/**
 * Maximum permitted protocol frame payload size in bytes (256 KiB).
 * Frames exceeding this threshold over WebSocket, SSE, or RPC are rejected.
 */
export const MAX_PROTOCOL_FRAME_BYTES = 262_144;

/**
 * Schema for standard protocol error objects returned when a command fails or validation fails.
 */
export const ProtocolErrorSchema = Type.Object(
	{
		code: Type.String({
			description:
				"Machine-readable error code identifying the failure category (e.g. 'invalid_command', 'not_found', 'unauthorized', 'conflict').",
		}),
		message: Type.String({
			description:
				"Human-readable explanation of why the command failed or could not be processed.",
		}),
	},
	{
		description:
			"Standard protocol error details included in rejected command results or error events.",
	},
);

/**
 * Strongly typed representation of a protocol error object.
 */
export type ProtocolError = Static<typeof ProtocolErrorSchema>;

/**
 * Error thrown when an incoming command frame violates the protocol schema or format constraints.
 */
export class ProtocolValidationError extends Error {
	readonly code: string;
	constructor(message: string, code = "invalid_command") {
		super(message);
		this.name = "ProtocolValidationError";
		this.code = code;
	}
}
