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
import { getLogger } from "../log.js";
import { parseThinkingLevel } from "../models.js";
import { ThinkingLevelSchema } from "../protocol.js";
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

export function internalToolsExtension() {
	return defineExtension({
		name: "cadmus.internal-tools",
		tasks: [SearchBotTask],
		tools: [
			defineTool({
				name: "create_bot",
				description:
					"Create a new peer bot in this Bot Family with its own persona (SOUL.md), memory, model, and tool policy.",
				parameters: Type.Object({
					slug: Type.Optional(Type.String()),
					name: Type.String({ minLength: 1 }),
					model: Type.Optional(Type.String()),
					thinking: Type.Optional(ThinkingLevelSchema),
					tools: Type.Optional(Type.Array(Type.String())),
					soul: Type.Optional(Type.String()),
					memory: Type.Optional(Type.String()),
				}),
				replay: "safe",
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
						const services = requireCadmusServices(context);
						const callerBot = services.familyStore.bots.getBot(scope.botId);
						const created = await services.createBot({
							slug: args.slug,
							name: args.name,
							model: args.model ?? callerBot?.model ?? "faux/echo",
							thinking: args.thinking ?? callerBot?.thinking ?? "off",
							tools: args.tools,
							soul: args.soul,
							memory: args.memory,
						});
						getLogger().info("peer bot created via create_bot tool", {
							callerBot: scope.botId,
							bot: created.id,
							model: created.model,
						});
						const record = created as unknown as JsonValue;
						await api.memo("result", record, context);
						return toolText(JSON.stringify(created));
					} catch (error) {
						return toolError((error as Error).message);
					}
				},
			}),

			defineTool({
				name: "search_bot",
				description:
					"Search for peer bots in this Bot Family matching a query or description. Evaluates bot names, SOUL.md personas, MEMORY.md, and knowledge summaries.",
				parameters: Type.Object({
					query: Type.Optional(Type.String()),
					description: Type.Optional(Type.String()),
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
				name: "message_bot",
				description:
					"Send a message to another bot in this Bot Family and await its response.",
				parameters: Type.Object({
					botId: Type.Optional(Type.String()),
					slug: Type.Optional(Type.String()),
					text: Type.String({ minLength: 1 }),
					chatKey: Type.Optional(Type.String()),
				}),
				replay: "safe",
				async execute(args, api, context) {
					const prior = await api.memo<JsonValue>("result", context);
					if (prior !== undefined) {
						return toolText(JSON.stringify(prior));
					}
					const scope = await resolveBotScope(api, context);
					if (!scope) {
						return toolError("Conversation is not bound to a bot.");
					}
					const targetBotId = (args.botId ?? args.slug ?? "").trim();
					if (!targetBotId) {
						return toolError("botId (or slug) is required.");
					}
					const services = requireCadmusServices(context);
					const targetBot = services.familyStore.bots.getBot(targetBotId);
					if (!targetBot) {
						return toolError(`Bot '${targetBotId}' not found in this family.`);
					}

					const peerChatKey =
						args.chatKey ?? `peer:${scope.botId}:${targetBotId}`;
					let peerChat = services.familyStore.chats.getChat(peerChatKey);
					if (!peerChat) {
						peerChat = await services.createChat({
							botId: targetBotId,
							key: peerChatKey,
							title: `Peer chat: ${scope.botId} -> ${targetBotId}`,
						});
					}

					getLogger().debug("inter-bot message sent", {
						fromBot: scope.botId,
						toBot: targetBotId,
						chat: peerChat.key,
					});

					const { reply } = await services.submitChatTurn({
						chatKey: peerChat.key,
						text: args.text,
						requestId: `peer:${api.taskId}`,
					});

					services.broadcast({
						type: "bot.message",
						payload: {
							fromBotId: scope.botId,
							toBotId: targetBotId,
							chatKey: peerChat.key,
							text: args.text,
							reply,
							when: Date.now(),
						},
					});

					const result = {
						fromBotId: scope.botId,
						toBotId: targetBotId,
						chatKey: peerChat.key,
						reply,
					};
					await api.memo("result", result, context);
					return toolText(JSON.stringify(result));
				},
			}),
		],
	});
}
