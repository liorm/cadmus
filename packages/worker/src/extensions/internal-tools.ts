import type { Context, JsonValue } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	type Cursor,
	configure,
	defineExtension,
	defineTask,
	defineTool,
	type RunningTask,
	type TaskId,
	type TaskRuntime,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { requireCadmusServices } from "../context.js";
import { GroupDriveTask } from "../group-chat/task.js";
import { getLogger } from "../log.js";
import { parseThinkingLevel } from "../models.js";
import { ThinkingLevelSchema, ToolsEnvSettingSchema } from "../protocol.js";
import { expandCodingOnlyAllowlist } from "./coding-allowlist.js";
import { resolveBotScope, toolError, toolText } from "./knowledge-tools.js";

export type SearchBotInput = {
	query: string;
	model: { provider: string; modelId: string };
	thinking: string;
	catalog: string;
	slugs: string[];
};

export type SearchBotResult = {
	slug: string | null;
	matches: string[];
};

type SearchCheckpoint = {
	phase: "match";
	round: number;
	conversationId?: ConversationId;
};

type SearchRuntime = TaskRuntime<
	SearchBotInput,
	SearchCheckpoint,
	SearchBotResult,
	object
>;

const SEARCH_INSTRUCTIONS =
	'You are a bot catalog matcher. Given a query and candidate bots, reply with JSON {"matches": ["<slug>"]} or a single matching bot slug, or "none" if none match.';

function lastAssistantText(messages: readonly Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		const content = message.content;
		if (typeof content === "string") return content;
		return content
			.map((part) => (part.type === "text" ? part.text : ""))
			.join("");
	}
	return "";
}

function parseSearchReply(
	text: string,
	validSlugs: readonly string[],
): { valid: boolean; matches: string[] } {
	const trimmed = text.trim();
	if (!trimmed) return { valid: false, matches: [] };
	if (trimmed.toLowerCase() === "none" || trimmed.toLowerCase() === "null") {
		return { valid: true, matches: [] };
	}

	// Try JSON {"matches": [...]}
	try {
		const parsed = JSON.parse(trimmed) as { matches?: unknown; slug?: unknown };
		if (Array.isArray(parsed.matches)) {
			const filtered = parsed.matches.filter(
				(m): m is string => typeof m === "string" && validSlugs.includes(m),
			);
			return { valid: true, matches: filtered };
		}
		if (typeof parsed.slug === "string" && validSlugs.includes(parsed.slug)) {
			return { valid: true, matches: [parsed.slug] };
		}
	} catch {
		// Fall back to direct slug matching
	}

	const clean = trimmed.replace(/^["'`]|["'`]$/g, "").trim();
	if (validSlugs.includes(clean)) {
		return { valid: true, matches: [clean] };
	}

	// Check if any valid slug appears as a distinct token
	const matched = validSlugs.filter((s) =>
		new RegExp(`\\b${s}\\b`, "i").test(trimmed),
	);
	if (matched.length > 0) {
		return { valid: true, matches: matched };
	}

	return { valid: false, matches: [] };
}

async function childConversation(
	task: RunningTask<SearchBotInput, SearchCheckpoint, SearchBotResult>,
	runtime: SearchRuntime,
	context: Context,
): Promise<ConversationId> {
	const known = task.state.checkpoint.conversationId;
	if (known !== undefined) return known;
	let createdId: ConversationId | undefined;
	await runtime.commit(async (tx, current) => {
		const existing = (await tx.scanConversations({ ownerTaskId: task.id }, 1))
			.items[0];
		if (existing) {
			createdId = existing.id;
		} else {
			const created = await tx.createConversation({
				ownership: { kind: "task", taskId: task.id },
			});
			const thinking = parseThinkingLevel(task.input.thinking);
			await configure(tx, created.id, {
				model: task.input.model,
				thinkingLevel: thinking ?? null,
				extensions: [],
				tools: [],
				instructions: SEARCH_INSTRUCTIONS,
				cwd: null,
			});
			createdId = created.id;
		}
		if (current.state.checkpoint.conversationId === createdId) return undefined;
		return {
			status: "running" as const,
			checkpoint: {
				...current.state.checkpoint,
				conversationId: createdId,
			},
		};
	}, context);
	if (createdId === undefined) {
		throw new Error("Search conversation was not created.");
	}
	return createdId;
}

export const SearchBotTask = defineTask<
	SearchBotInput,
	SearchCheckpoint,
	SearchBotResult
>({
	name: "cadmus.search_bot",
	version: 1,
	initial: () => ({ phase: "match", round: 1 }),
	async abort(_task, runtime, context) {
		await runtime.commit(
			async () => ({
				status: "terminal" as const,
				outcome: { status: "aborted" as const, reason: "search aborted" },
			}),
			context,
		);
	},
	phases: {
		async match(task, runtime, context) {
			const round = task.state.checkpoint.round;
			const conversationId = await childConversation(task, runtime, context);
			const handle = await runtime.conversation(conversationId, context);
			if (!handle) {
				await runtime.commit(
					async () => ({
						status: "terminal" as const,
						outcome: {
							status: "failed" as const,
							error: { message: "Search conversation is missing." },
						},
					}),
					context,
				);
				return;
			}

			const prompt =
				round <= 1
					? `[SEARCH_BOT_JUDGE]\nQUERY: ${task.input.query}\n\n${task.input.catalog}`
					: `[SEARCH_BOT_JUDGE]\nQUERY: ${task.input.query}\nReply ONLY with JSON {"matches": ["<slug>"]} from [${task.input.slugs.join(", ")}] or {"matches": []}.\n\n${task.input.catalog}`;

			const submission = await handle.submit(
				{
					type: "input",
					content: prompt,
					requestId: `search:${task.id}:${round}`,
				},
				context,
			);
			const settled = await submission.wait(context);
			if (settled.status !== "done") {
				await runtime.commit(
					async () => ({
						status: "terminal" as const,
						outcome: {
							status: "failed" as const,
							error: { message: settled.reason || "Search failed." },
						},
					}),
					context,
				);
				return;
			}

			const answered = await runtime.context(conversationId, context);
			const text = lastAssistantText(answered.messages);
			const parsed = parseSearchReply(text, task.input.slugs);

			if (parsed.valid || round >= 3) {
				const matches = parsed.matches;
				getLogger().debug("search_bot finished", {
					query: task.input.query,
					round,
					matches,
				});
				await runtime.commit(
					async () => ({
						status: "terminal" as const,
						outcome: {
							status: "completed" as const,
							result: {
								slug: matches[0] ?? null,
								matches,
							},
						},
					}),
					context,
				);
				return;
			}

			await runtime.commit(
				async (_tx, current) => ({
					status: "running" as const,
					checkpoint: {
						phase: "match" as const,
						round: round + 1,
						...(current.state.checkpoint.conversationId !== undefined
							? { conversationId: current.state.checkpoint.conversationId }
							: {}),
					},
				}),
				context,
			);
		},
	},
});

const TOOLS_ENV_BINDING_KEYS = new Set(["envId"]);

/** Bindings store envId only. Pairing material stays on the account env row. */
function rejectToolsEnvBindingExtras(toolsEnv: unknown): void {
	if (toolsEnv == null || typeof toolsEnv !== "object") return;
	const binding = (toolsEnv as { binding?: unknown }).binding;
	if (
		binding == null ||
		typeof binding !== "object" ||
		Array.isArray(binding)
	) {
		return;
	}
	for (const key of Object.keys(binding)) {
		if (!TOOLS_ENV_BINDING_KEYS.has(key)) {
			throw new Error(`toolsEnv binding rejects '${key}'`);
		}
	}
}

export function internalToolsExtension() {
	return defineExtension({
		name: "cadmus.internal-tools",
		tasks: [SearchBotTask, GroupDriveTask],
		tools: [
			defineTool({
				name: "create_bot",
				description:
					"Create a new peer bot in this Bot Family with its own persona (SOUL.md), memory, knowledge documents, model, and tool policy. Knowledge and memory passed here are stored on the new bot only. Do not follow this call with knowledge_update or memory_update to copy those documents: those tools write the caller, not the peer.",
				parameters: Type.Object({
					slug: Type.Optional(Type.String()),
					name: Type.String({ minLength: 1 }),
					model: Type.Optional(Type.String()),
					thinking: Type.Optional(ThinkingLevelSchema),
					tools: Type.Optional(Type.Array(Type.String())),
					soul: Type.Optional(Type.String()),
					memory: Type.Optional(
						Type.String({
							description:
								"Initial MEMORY.md body stored on the new bot, not on you.",
						}),
					),
					knowledge: Type.Optional(
						Type.Array(
							Type.Object({
								slug: Type.String({
									description:
										"Knowledge slug on the new bot (lowercase letters, digits, hyphens, 1-64 chars).",
								}),
								description: Type.String({
									description:
										"One-line summary stored on the new bot (<= 240 chars).",
								}),
								category: Type.Optional(Type.String()),
								body: Type.String({
									description:
										"Markdown body stored on the new bot, without a --- frontmatter fence.",
								}),
							}),
							{
								description:
									"Initial knowledge documents created on the new bot. This is the only way for you to attach knowledge to a peer at creation. knowledge_update cannot target them.",
							},
						),
					),
					toolsEnv: Type.Optional(ToolsEnvSettingSchema),
				}),
				replay: "safe",
				executionMode: "sequential",
				async execute(args, api, context) {
					const prior = await api.memo<JsonValue>("result", context);
					if (prior !== undefined) {
						return toolText(JSON.stringify(prior));
					}
					const scope = await resolveBotScope(api, context);
					if (!scope) {
						return toolError("Conversation is not bound to a bot.");
					}
					try {
						rejectToolsEnvBindingExtras(args.toolsEnv);
						const services = requireCadmusServices(context);
						const callerBot = services.familyStore.bots.getBot(scope.botId);
						const created = await services.createBot({
							slug: args.slug,
							name: args.name,
							model: args.model ?? callerBot?.model ?? "faux/echo",
							thinking: args.thinking ?? callerBot?.thinking ?? "off",
							tools: expandCodingOnlyAllowlist(args.tools),
							soul: args.soul,
							memory: args.memory,
							knowledge: args.knowledge,
							toolsEnv: args.toolsEnv,
						});
						getLogger().info("peer bot created via create_bot tool", {
							callerBot: scope.botId,
							bot: created.id,
							model: created.model,
						});
						const record = {
							...created,
							slug: created.id,
						} as unknown as JsonValue;
						await api.memo("result", record, context);
						return toolText(JSON.stringify(record));
					} catch (error) {
						return toolError((error as Error).message);
					}
				},
			}),

			defineTool({
				name: "search_bot",
				description:
					"Search for peer bots in this Bot Family matching a query, topic, or description. Evaluates bot names, SOUL.md personas, MEMORY.md, and knowledge summaries to identify the single most relevant bot. Always use this tool first when looking for information that might be held by other bots or determining which bot is responsible for a specific topic, domain, or task.",
				parameters: Type.Object({
					query: Type.Optional(
						Type.String({
							description:
								"Topic, domain keywords, or question to search peer bots for.",
						}),
					),
					description: Type.Optional(
						Type.String({
							description:
								"Alternative description of the role, capability, or knowledge domain needed.",
						}),
					),
				}),
				replay: "safe",
				async execute(args, api, context) {
					const query = (args.query ?? args.description ?? "").trim();
					if (!query) {
						return toolError("query (or description) is required.");
					}
					const services = requireCadmusServices(context);
					const bots = services.familyStore.bots.listBots();
					if (bots.length === 0) {
						return toolText(JSON.stringify({ slug: null, matches: [] }));
					}

					const catalogBlocks: string[] = [];
					const slugs: string[] = [];
					for (const bot of bots) {
						slugs.push(bot.id);
						const soul = services.familyStore.files.getSoul(bot.id);
						const memory = services.familyStore.files.getMemory(bot.id).content;
						const knowledge = services.familyStore.files
							.listKnowledge(bot.id)
							.map((k) => `${k.slug}: ${k.description}`)
							.join("; ");
						catalogBlocks.push(
							[
								`CANDIDATE_BOT: ${bot.id}`,
								`Name: ${bot.name}`,
								`Soul: ${soul.slice(0, 400)}`,
								...(memory ? [`Memory: ${memory.slice(0, 200)}`] : []),
								...(knowledge ? [`Knowledge: ${knowledge}`] : []),
							].join("\n"),
						);
					}

					const agent = await api.agent(context);
					const model = agent.model ?? { provider: "faux", modelId: "echo" };

					const taskId = await api.commit(async (tx) => {
						let cursor: Cursor | undefined;
						for (;;) {
							const page = await tx.scanTasks(
								{ kind: SearchBotTask.definition.name },
								50,
								cursor,
							);
							const found = page.items.find((item) => {
								const rec = item as unknown as {
									owner?: unknown;
									ownership?: { kind?: string; taskId?: unknown };
								};
								return (
									rec.owner === api.taskId ||
									(rec.ownership?.kind === "task" &&
										rec.ownership.taskId === api.taskId)
								);
							});
							if (found) return found.id as TaskId<SearchBotResult>;
							if (!page.next) break;
							cursor = page.next;
						}
						return tx.createTask(
							SearchBotTask,
							{
								query,
								model: { provider: model.provider, modelId: model.modelId },
								thinking: agent.thinkingLevel ?? "off",
								catalog: catalogBlocks.join("\n\n"),
								slugs,
							},
							{ ownership: { kind: "task", taskId: api.taskId } },
						);
					}, context);

					const settled = await api.waitForTask(taskId, context);
					const outcome = settled.state.outcome;
					if (outcome.status === "completed") {
						return toolText(JSON.stringify(outcome.result));
					}
					if (outcome.status === "aborted") {
						return toolError("Bot search was aborted.");
					}
					if (outcome.status === "failed") {
						return toolError(outcome.error.message);
					}
					return toolError("Bot search did not complete.");
				},
			}),

			defineTool({
				name: "list_bots",
				// Cadmus settings read-only: execute() lists slug and name.
				description:
					"List all bots in this Bot Family. Returns only the slug and display name of each bot. Do NOT use this tool to search for a bot to answer a question or check for specific information—use search_bot instead, which inspects bot personas, memories, and knowledge summaries. Only use list_bots when the user explicitly requests an exhaustive roster or inventory of all bots.",
				parameters: Type.Object({}),
				replay: "safe",
				async execute(_args, _api, context) {
					const services = requireCadmusServices(context);
					const bots = services.familyStore.bots.listBots();
					return toolText(
						JSON.stringify({
							bots: bots.map((bot) => ({
								slug: bot.id,
								name: bot.name,
							})),
						}),
					);
				},
			}),

			defineTool({
				name: "message_bot",
				description:
					"Open a new group chat in this family. Pass slug for one target, or to: [slug, ...] for several. topic is required. When seeking answers or checking records from other bots, NEVER message all bots at once—use search_bot first to find the single relevant bot, then message that bot with slug and pass readOnly: true. In a two-member chat with wait: true, every message gets a reply from the other member; when you receive the needed information (or confirmation that none exists), call end_conversation immediately to finish rather than sending back-and-forth chit-chat or acknowledgments. wait defaults to true and blocks until you call end_conversation, the 10-turn cap, or the watchdog. wait false returns immediately with the group chat id and topic. A two-member fire-and-forget chat ends on the target's first reply. A larger one ends when every bot mentioned in the opening has replied once (or on cap or timeout). That result is delivered later as a new turn in this chat. Same family only. Legacy peer chats are not reused. Cost is charged to you. readOnly defaults to false. readOnly true still opens a normal group chat (topic required, visible, user read-only, same limits) but each target session is offered only knowledge_read and memory_read. Harvest stays off. Your own session in that chat keeps its tools, including end_conversation.",
				parameters: Type.Object({
					slug: Type.Optional(
						Type.String({
							description:
								"Target bot slug. Creates a group chat with you and this bot. Omit when passing to. Prefer this over to when asking a specific bot for information.",
						}),
					),
					to: Type.Optional(
						Type.Array(Type.String({ minLength: 1 }), {
							description:
								"Target bot slugs. Creates one group chat with you and these bots. Omit this and pass slug for a single target. Do not pass all bots in the family.",
						}),
					),
					topic: Type.String({
						minLength: 1,
						description: "Topic of the group chat.",
					}),
					text: Type.String({ minLength: 1 }),
					chatKey: Type.Optional(Type.String()),
					wait: Type.Optional(
						Type.Boolean({
							description:
								"True waits for the group chat to finish. False returns the group chat id immediately.",
						}),
					),
					readOnly: Type.Optional(
						Type.Boolean({
							description:
								"When true, each target is offered only knowledge_read and memory_read. Writes, schedules, messaging, and coding tools are refused. Recommended when querying peer bots for information. Defaults to false.",
						}),
					),
				}),
				replay: "safe",
				executionMode: "sequential",
				async execute(args, api, context) {
					const prior = await api.memo<JsonValue>("result", context);
					if (prior !== undefined) {
						return toolText(JSON.stringify(prior));
					}
					if (args.chatKey) {
						return toolError(
							"chatKey is not used. message_bot always creates a new group chat. Do not target another bot's chat.",
						);
					}
					if (!args.topic?.trim()) {
						return toolError("topic is required.");
					}
					const scope = await resolveBotScope(api, context);
					if (!scope?.chatKey) {
						return toolError("Conversation is not bound to a bot.");
					}
					const listed = (args.to ?? [])
						.map((id) => id.trim())
						.filter((id) => id.length > 0);
					const rawArgs = args as { slug?: string; botId?: string };
					const single = (rawArgs.slug ?? rawArgs.botId ?? "").trim();
					if (listed.length > 0 && single) {
						return toolError("Pass slug or to, not both.");
					}
					const targetBotIds =
						listed.length > 0 ? listed : single ? [single] : [];
					if (targetBotIds.length === 0) {
						return toolError("slug is required.");
					}
					const topic = args.topic.trim();
					const services = requireCadmusServices(context);
					await services.adoptGroupWakeRoot(scope.chatKey);
					const result = await services.runMessageBot({
						taskId: String(api.taskId),
						callerBotId: scope.botId,
						targetBotIds,
						topic,
						text: args.text,
						originChatKey: scope.chatKey,
						wait: args.wait !== false,
						readOnly: args.readOnly === true,
					});
					if (!result.ok) return toolError(result.error);
					if (result.status === "pending") {
						const driveId = String(api.taskId);
						await api.commit(async (tx) => {
							let cursor: Cursor | undefined;
							for (;;) {
								const page = await tx.scanTasks(
									{ kind: GroupDriveTask.definition.name },
									50,
									cursor,
								);
								const found = page.items.find((item) => {
									const input = item.input as { taskId?: string };
									return input.taskId === driveId;
								});
								if (found) return found.id;
								if (!page.next) break;
								cursor = page.next;
							}
							return tx.createTask(
								GroupDriveTask,
								{ taskId: driveId },
								{
									ownership: { kind: "conversation" },
									background: true,
								},
							);
						}, context);
					}
					const payload = result as unknown as JsonValue;
					await api.memo("result", payload, context);
					return toolText(JSON.stringify(result));
				},
			}),
			defineTool({
				name: "end_conversation",
				description:
					"End the group chat you started and return this response to your waiting message_bot call. Offered only in that caller session. When you initiated a group chat with message_bot, you MUST call end_conversation immediately once the target bot provides the answer or confirms it has no information. Do NOT reply with chit-chat, 'Understood', 'Got it', or pleasantries as regular messages, because each message requires another turn from the peer until hitting the 10-turn cap.",
				parameters: Type.Object({
					response: Type.String({
						minLength: 1,
						description:
							"Summary or final response to return to the waiting caller session.",
					}),
				}),
				replay: "safe",
				executionMode: "sequential",
				async execute(args, api, context) {
					const prior = await api.memo<JsonValue>("result", context);
					if (prior !== undefined) return toolText(JSON.stringify(prior));
					const scope = await resolveBotScope(api, context);
					if (!scope?.chatKey) {
						return toolError("Conversation is not bound to a bot.");
					}
					const services = requireCadmusServices(context);
					if (!services.isGroupCallerSession(scope.chatKey)) {
						return toolError(
							"end_conversation is only available in a group chat you started.",
						);
					}
					const ended = services.endGroupConversation(
						scope.chatKey,
						args.response,
					);
					if (!ended) {
						return toolError("This group chat is not open.");
					}
					const payload = { response: args.response, ended: true };
					await api.memo("result", payload, context);
					return toolText(JSON.stringify(payload));
				},
			}),
		],
	});
}
