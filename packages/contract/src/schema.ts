import { ClientCommandSchema } from "./commands.js";
import { ServerFrameSchema } from "./frames.js";

/**
 * Standard JSON Schema bundle for external / native client code generation,
 * API documentation, and runtime validation inspection.
 *
 * Exposed via the Edge Worker endpoint `GET /protocol/schema`.
 */
export const PROTOCOL_JSON_SCHEMA = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	title: "CadmusProtocol",
	description:
		"Public wire protocol schema for Cadmus AI agent gateway, defining all client commands, RPC contracts, server frames, and streaming events.",
	version: "1.0.0",
	clientCommand: ClientCommandSchema,
	serverFrame: ServerFrameSchema,
} as const;
