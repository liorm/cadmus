import type { Context } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	configure,
	defineTask,
	type RunningTask,
	type TaskRuntime,
} from "@earendil-works/pi-durable";
import { parseThinkingLevel } from "../../harness/models.ts";
import {
	parseSearchAnswer,
	SEARCH_INSTRUCTIONS,
	SEARCH_ROUNDS,
	searchRequest,
	searchRetry,
} from "./match.ts";

export type SearchBotInput = {
	description: string;
	model: { provider: string; modelId: string };
	thinking: string;
	catalog: string;
	slugs: string[];
};

export type SearchBotResult = { slug: string | null };

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

/** Create the tool-less child once and keep its id on the checkpoint. */
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
	if (createdId === undefined)
		throw new Error("Search conversation was not created.");
	return createdId;
}

async function finish(
	runtime: SearchRuntime,
	context: Context,
	slug: string | null,
): Promise<void> {
	await runtime.commit(
		async () => ({
			status: "terminal" as const,
			outcome: {
				status: "completed" as const,
				result: { slug },
			},
		}),
		context,
	);
}

async function fail(
	runtime: SearchRuntime,
	context: Context,
	message: string,
): Promise<void> {
	await runtime.commit(
		async () => ({
			status: "terminal" as const,
			outcome: {
				status: "failed" as const,
				error: { message },
			},
		}),
		context,
	);
}

async function match(
	task: RunningTask<SearchBotInput, SearchCheckpoint, SearchBotResult>,
	runtime: SearchRuntime,
	context: Context,
): Promise<void> {
	const round = task.state.checkpoint.round;
	const conversationId = await childConversation(task, runtime, context);
	const handle = await runtime.conversation(conversationId, context);
	if (!handle) {
		await fail(runtime, context, "Search conversation is missing.");
		return;
	}
	const view = await runtime.context(conversationId, context);
	const content =
		round <= 1
			? searchRequest(task.input.catalog, task.input.description)
			: searchRetry(lastAssistantText(view.messages));
	const submission = await handle.submit(
		{
			type: "input",
			content,
			requestId: `search:${task.id}:${round}`,
		},
		context,
	);
	const settled = await submission.wait(context);
	if (settled.status !== "done") {
		await fail(runtime, context, settled.reason || "Search was not answered.");
		return;
	}
	const answered = await runtime.context(conversationId, context);
	const text = lastAssistantText(answered.messages);
	const parsed = parseSearchAnswer(text, task.input.slugs);
	if (parsed.kind === "slug") {
		await finish(runtime, context, parsed.slug);
		return;
	}
	if (parsed.kind === "none" || round >= SEARCH_ROUNDS) {
		await finish(runtime, context, null);
		return;
	}
	await runtime.commit(
		async (_tx, current) => ({
			status: "running" as const,
			checkpoint: {
				phase: "match" as const,
				round: round + 1,
				...(current.state.checkpoint.conversationId === undefined
					? {}
					: { conversationId: current.state.checkpoint.conversationId }),
			},
		}),
		context,
	);
}

async function abort(
	_task: RunningTask<SearchBotInput, SearchCheckpoint, SearchBotResult>,
	runtime: SearchRuntime,
	context: Context,
): Promise<void> {
	await runtime.commit(
		async () => ({
			status: "terminal" as const,
			outcome: { status: "aborted" as const, reason: "search aborted" },
		}),
		context,
	);
}

/** One model pass, then up to two retries when the reply is not a catalog slug. */
export const SearchBotTask = defineTask<
	SearchBotInput,
	SearchCheckpoint,
	SearchBotResult
>({
	name: "pi-bot.search-bot",
	version: 1,
	initial: () => ({ phase: "match", round: 1 }),
	phases: { match },
	abort,
});
