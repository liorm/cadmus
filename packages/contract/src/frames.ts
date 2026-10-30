import { type Static, Type } from "typebox";
import { type ProtocolError, ProtocolErrorSchema } from "./common.js";
import { OAuthFlowRecordSchema } from "./oauth.js";
import { HarvestNoteSchema, TurnBlockSchema } from "./records.js";

// ─── Outbound Server Frames ──────────────────────────────────────────────────

/**
 * Standard envelope returned in response to a client command over WebSocket, SSE, or HTTP RPC.
 */
export const CommandResultFrameSchema = Type.Object(
	{
		id: Type.String({
			description:
				"Correlation identifier matching the 'id' of the originating client command.",
		}),
		type: Type.Literal("command.result", {
			description: "Frame type identifier for command responses.",
		}),
		command: Type.Optional(
			Type.String({
				description:
					"Type name of the command that produced this result (e.g. 'turn.submit', 'chat.get').",
			}),
		),
		ok: Type.Boolean({
			description:
				"True if the command succeeded, or false if an error occurred.",
		}),
		result: Type.Optional(
			Type.Unknown({
				description:
					"Success result payload matching the command's expected RPC contract (present when ok is true).",
			}),
		),
		payload: Type.Optional(
			Type.Unknown({
				description: "Backward-compatible alias for the 'result' property.",
			}),
		),
		error: Type.Optional(ProtocolErrorSchema),
	},
	{
		description:
			"Standard response frame returned by the server for all client command invocations.",
	},
);

/**
 * Strongly typed command response frame parameterized by its success payload type T.
 */
export type CommandResultFrame<T = unknown> = Omit<
	Static<typeof CommandResultFrameSchema>,
	"result" | "payload" | "error"
> & {
	result?: T;
	payload?: T;
	error?: ProtocolError;
};

// ─── Individual Server Events ────────────────────────────────────────────────

/**
 * Streaming token or thinking chunk event emitted during model response generation.
 */
export const TurnDeltaEventSchema = Type.Object(
	{
		type: Type.Literal("turn.delta", {
			description:
				"Event type identifier for streaming text or thinking chunks.",
		}),
		payload: Type.Object(
			{
				chatKey: Type.String({
					description:
						"Routing key of the chat session where the turn is executing.",
				}),
				kind: Type.Union(
					[
						Type.Literal("text", {
							description: "Incremental assistant response text.",
						}),
						Type.Literal("thinking", {
							description: "Incremental extended reasoning / thinking tokens.",
						}),
					],
					{
						description:
							"Chunk content kind: generated 'text' or internal 'thinking'.",
					},
				),
				delta: Type.String({
					description: "Incremental text fragment generated in this chunk.",
				}),
			},
			{ description: "Streaming chunk payload." },
		),
	},
	{
		description:
			"Real-time streaming event emitted as the model generates text or reasoning tokens.",
	},
);
export type TurnDeltaEvent = Static<typeof TurnDeltaEventSchema>;

/**
 * Event emitted when the model initiates an agent tool call.
 */
export const TurnToolCallEventSchema = Type.Object(
	{
		type: Type.Literal("turn.tool_call", {
			description: "Event type identifier for tool call requests.",
		}),
		payload: Type.Object(
			{
				chatKey: Type.String({
					description: "Chat session routing key.",
				}),
				toolCallId: Type.String({
					description:
						"Unique identifier for this tool call execution instance.",
				}),
				toolName: Type.String({
					description:
						"Name of the tool being called (e.g. 'knowledge_read', 'schedule_create', 'web.fetch').",
				}),
				args: Type.Record(Type.String(), Type.Unknown(), {
					description: "Dictionary of arguments passed to the tool.",
				}),
			},
			{ description: "Tool call invocation details." },
		),
	},
	{
		description:
			"Event notification that the model has requested execution of an agent tool.",
	},
);
export type TurnToolCallEvent = Static<typeof TurnToolCallEventSchema>;

/**
 * Event emitted when an agent tool finishes execution and returns output.
 */
export const TurnToolResultEventSchema = Type.Object(
	{
		type: Type.Literal("turn.tool_result", {
			description: "Event type identifier for tool call results.",
		}),
		payload: Type.Object(
			{
				chatKey: Type.String({
					description: "Chat session routing key.",
				}),
				toolCallId: Type.String({
					description:
						"Correlation identifier matching the originating toolCallId.",
				}),
				toolName: Type.String({
					description: "Name of the tool that finished executing.",
				}),
				content: Type.String({
					description:
						"Serialized string output or return value produced by the tool.",
				}),
				isError: Type.Boolean({
					description: "True if the tool threw an error or failed execution.",
				}),
			},
			{ description: "Tool execution result details." },
		),
	},
	{
		description:
			"Event notification providing the result or error produced by an agent tool.",
	},
);
export type TurnToolResultEvent = Static<typeof TurnToolResultEventSchema>;

/**
 * Terminal event emitted when a model turn completes execution and settles.
 */
export const TurnCompletedEventSchema = Type.Object(
	{
		type: Type.Literal("turn.completed", {
			description: "Event type identifier for turn completion.",
		}),
		payload: Type.Object(
			{
				chatKey: Type.String({
					description: "Chat session routing key.",
				}),
				entryId: Type.Optional(
					Type.Number({
						description:
							"Transcript entry sequence number assigned to this turn.",
					}),
				),
				status: Type.Union(
					[
						Type.Literal("done", {
							description: "Turn completed successfully with a response.",
						}),
						Type.Literal("unanswered", {
							description:
								"Turn terminated without producing an assistant reply.",
						}),
						Type.Literal("command", {
							description: "Turn was handled out-of-band as a slash command.",
						}),
					],
					{
						description: "Terminal status: 'done', 'unanswered', or 'command'.",
					},
				),
				text: Type.Optional(
					Type.String({
						description: "Full final assistant text reply.",
					}),
				),
				reason: Type.Optional(
					Type.String({
						description:
							"Model completion finish reason (e.g. 'stop', 'length', 'tool_use', 'aborted').",
					}),
				),
				blocks: Type.Optional(
					Type.Array(TurnBlockSchema, {
						description:
							"Structured content blocks (thinking, tool calls, text) produced during the turn.",
					}),
				),
			},
			{ description: "Completed turn details and final content." },
		),
	},
	{
		description:
			"Terminal event emitted when a conversation turn finishes all reasoning, tools, and response output.",
	},
);
export type TurnCompletedEvent = Static<typeof TurnCompletedEventSchema>;

/**
 * Event emitted when chat session runtime status or state changes.
 */
export const ChatStateEventSchema = Type.Object(
	{
		type: Type.Literal("chat.state", {
			description: "Event type identifier for chat state changes.",
		}),
		payload: Type.Object(
			{
				chatKey: Type.String({
					description: "Chat session routing key.",
				}),
				botId: Type.String({
					description: "Identifier of the participating bot.",
				}),
				conversationId: Type.Number({
					description:
						"Internal durable conversation sequence ID backing this chat.",
				}),
				busy: Type.Boolean({
					description:
						"True if a model turn or scheduled task is actively running, false when idle.",
				}),
				model: Type.Optional(
					Type.String({
						description: "Active model identifier used in this chat.",
					}),
				),
				thinking: Type.Optional(
					Type.String({
						description: "Active thinking level override.",
					}),
				),
				usage: Type.Optional(
					Type.Record(Type.String(), Type.Unknown(), {
						description: "Updated session usage metrics.",
					}),
				),
			},
			{ description: "Updated chat session state." },
		),
	},
	{
		description:
			"Event emitted when a chat session transitions between busy and idle or updates configuration.",
	},
);
export type ChatStateEvent = Static<typeof ChatStateEventSchema>;

/**
 * Event emitted when an idle conversation harvest completes, updating memory or knowledge.
 */
export const HarvestNoteEventSchema = Type.Object(
	{
		type: Type.Literal("harvest.note", {
			description: "Event type identifier for idle harvest notifications.",
		}),
		payload: HarvestNoteSchema,
	},
	{
		description:
			"Event emitted when an idle conversation harvest run completes and saves memory or knowledge file diffs.",
	},
);
export type HarvestNoteEvent = Static<typeof HarvestNoteEventSchema>;

/**
 * Event emitted when an inter-bot message is sent between bots in the family.
 */
export const BotMessageEventSchema = Type.Object(
	{
		type: Type.Literal("bot.message", {
			description: "Event type identifier for inter-bot messaging.",
		}),
		payload: Type.Object(
			{
				fromBotId: Type.String({
					description: "Identifier of the bot initiating the message.",
				}),
				toBotId: Type.String({
					description: "Identifier of the recipient bot.",
				}),
				chatKey: Type.String({
					description:
						"Chat session routing key where the exchange took place.",
				}),
				text: Type.String({
					description: "Prompt text sent to the recipient bot.",
				}),
				reply: Type.Optional(
					Type.String({
						description:
							"Optional response text returned by the recipient bot.",
					}),
				),
				when: Type.Number({
					description:
						"Epoch timestamp in milliseconds when the message was dispatched.",
				}),
				groupChatKey: Type.Optional(
					Type.String({
						description:
							"Group chat that holds the exchange. Clients link the inter-bot card here.",
					}),
				),
			},
			{ description: "Inter-bot message exchange payload." },
		),
	},
	{
		description:
			"Event notification dispatched when bots communicate autonomously within a bot family.",
	},
);
export type BotMessageEvent = Static<typeof BotMessageEventSchema>;

/**
 * Event emitted when account-level configurations (such as BYOK credentials) change.
 */
export const AccountEventSchema = Type.Object(
	{
		type: Type.Literal("account.event", {
			description: "Event type identifier for account-level changes.",
		}),
		payload: Type.Object(
			{
				accountId: Type.String({
					description: "Tenant account identifier.",
				}),
				action: Type.Union(
					[
						Type.Literal("credential.set", {
							description: "A provider credential was added or updated.",
						}),
						Type.Literal("credential.deleted", {
							description: "A provider credential was removed.",
						}),
						Type.Literal("credential.refreshed", {
							description: "An OAuth credential token set was refreshed.",
						}),
					],
					{
						description:
							"Action type: 'credential.set', 'credential.deleted', or 'credential.refreshed'.",
					},
				),
				providerId: Type.String({
					description: "Identifier of the provider affected.",
				}),
				when: Type.Number({
					description:
						"Epoch timestamp in milliseconds when the event occurred.",
				}),
			},
			{ description: "Account event payload." },
		),
	},
	{
		description:
			"Broadcast event for account-level credential additions, updates, or deletions.",
	},
);
export type AccountEvent = Static<typeof AccountEventSchema>;

/**
 * Event emitted when an OAuth authorization flow transitions state or requests input.
 */
export const AccountOAuthEventSchema = Type.Object(
	{
		type: Type.Literal("account.oauth.event", {
			description: "Event type identifier for OAuth lifecycle updates.",
		}),
		payload: OAuthFlowRecordSchema,
	},
	{
		description:
			"Broadcast event tracking progression and status updates of an active OAuth authorization flow.",
	},
);
export type AccountOAuthEvent = Static<typeof AccountOAuthEventSchema>;

/**
 * Event emitted when a connection-level or unrecoverable protocol error occurs.
 */
export const ProtocolErrorEventSchema = Type.Object(
	{
		id: Type.Optional(
			Type.String({
				description:
					"Optional correlation ID matching the failed command request.",
			}),
		),
		type: Type.Literal("protocol.error", {
			description: "Event type identifier for protocol errors.",
		}),
		payload: ProtocolErrorSchema,
	},
	{
		description:
			"Asynchronous error event emitted when a protocol-level violation occurs on the connection.",
	},
);
export type ProtocolErrorEvent = Static<typeof ProtocolErrorEventSchema>;

/**
 * Discriminated union of all asynchronous server push events.
 */
export const ServerEventSchema = Type.Union(
	[
		TurnDeltaEventSchema,
		TurnToolCallEventSchema,
		TurnToolResultEventSchema,
		TurnCompletedEventSchema,
		ChatStateEventSchema,
		HarvestNoteEventSchema,
		BotMessageEventSchema,
		AccountEventSchema,
		AccountOAuthEventSchema,
		ProtocolErrorEventSchema,
	],
	{
		description:
			"Discriminated union of all asynchronous event frames sent from server to client.",
	},
);
export type ServerEvent = Static<typeof ServerEventSchema>;

/**
 * Discriminated union of all server-to-client frames (command results and push events).
 */
export const ServerFrameSchema = Type.Union(
	[CommandResultFrameSchema, ServerEventSchema],
	{
		description:
			"Complete union of all possible frames sent from server to client over WebSocket, SSE, or RPC.",
	},
);
export type ServerFrame<T = unknown> = CommandResultFrame<T> | ServerEvent;
