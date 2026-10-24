import {
	type ClientCommand,
	ClientCommandSchema,
	type CommandType,
} from "./commands.js";
import {
	type ServerEvent,
	ServerEventSchema,
	type ServerFrame,
	ServerFrameSchema,
} from "./frames.js";

/**
 * WebSocket client-to-server messages. Discriminated on `type` (the command name).
 */
export const ClientToServerSchema = ClientCommandSchema;
export type ClientToServer = ClientCommand;

/**
 * WebSocket server-to-client messages. Discriminated on `type`.
 * Includes `command.result` and every push event.
 */
export const ServerToClientSchema = ServerFrameSchema;
export type ServerToClient = ServerFrame;

/**
 * SSE (`GET /events`) payloads differ from WebSocket frames: each `data:`
 * line is a `ServerEvent` (push events and `protocol.error` only).
 * `command.result` is not sent on `/events`. A leading `: connected` comment
 * is a heartbeat, not a protocol message.
 */
export const SseEventSchema = ServerEventSchema;
export type SseEvent = ServerEvent;

export const MESSAGE_CHANNELS = {
	ws: {
		address: "/ws",
		clientToServer: "ClientToServer",
		serverToClient: "ServerToClient",
	},
	events: {
		address: "/events",
		serverToClient: "SseEvent",
	},
} as const;

export type WsCommandName = CommandType;
