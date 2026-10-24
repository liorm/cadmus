import {
	type ClientCommand,
	ClientCommandSchema,
	type CommandType,
} from "@cadmus/contract/schemas";
import { Value } from "typebox/value";

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

const EDGE_COMMAND_TYPES = new Set<CommandType>([
	"account.get",
	"account.update",
	"account.members.list",
	"account.members.add",
	"account.credentials.list",
	"account.credentials.set",
	"account.credentials.delete",
	"account.models.list",
	"account.oauth.providers",
	"account.oauth.start",
	"account.oauth.status",
	"account.oauth.submit",
	"account.oauth.cancel",
	"family.list",
	"family.create",
	"family.delete",
]);

/**
 * Returns true if the command is handled exclusively at the Edge worker level without forwarding to a Durable Object.
 */
export function isEdgeOnlyCommand(type: CommandType): boolean {
	return EDGE_COMMAND_TYPES.has(type);
}

/**
 * Validates an unknown incoming payload against ClientCommandSchema.
 * Throws ProtocolValidationError with an informative message if validation fails.
 */
export function validateClientCommand(input: unknown): ClientCommand {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new ProtocolValidationError(
			"Command must be a JSON object",
			"invalid_command",
		);
	}
	const record = input as Record<string, unknown>;
	if (typeof record.id !== "string" || record.id.trim().length === 0) {
		throw new ProtocolValidationError(
			"Command 'id' must be a non-empty string",
			"invalid_command",
		);
	}
	if (typeof record.type !== "string" || record.type.trim().length === 0) {
		throw new ProtocolValidationError(
			"Command 'type' must be a non-empty string",
			"invalid_command",
		);
	}
	if (!Value.Check(ClientCommandSchema, input)) {
		const errors = [...Value.Errors(ClientCommandSchema, input)];
		const first = errors[0];
		const detail = first
			? `${first.instancePath || "/"} ${first.message}`
			: "Schema validation failed";
		throw new ProtocolValidationError(
			`Invalid command '${record.type}': ${detail}`,
			"invalid_command",
		);
	}
	return input;
}
