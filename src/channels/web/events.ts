import {
	BACKGROUND_CONTEXT,
	withAbortSignal,
} from "@earendil-works/chord/context";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import type {
	ConversationId,
	ConversationView,
	EntryRecord,
	Harness,
	LiveState,
} from "@earendil-works/pi-durable";
import {
	type HarvestFile,
	type HarvestNote,
	HarvestNotesDoc,
} from "../../schedules/harvest.ts";
import {
	latestAssistantError,
	liveTools,
	partialText,
	projectEntries,
	type ToolChip,
	type TranscriptItem,
} from "./transcript.ts";

export type ChatState = {
	busy: boolean;
	messages: TranscriptItem[];
	partial?: string;
	tools: ToolChip[];
	notes: HarvestView[];
	contextPercent?: number;
};

export type HarvestView = { at: number; files: HarvestFile[]; when: number };

type Frame =
	| { event: "state"; data: ChatState }
	| { event: "delta"; data: { text: string } }
	| { event: "tool"; data: ToolChip }
	| { event: "done"; data: Record<string, never> }
	| { event: "error"; data: { message: string } }
	| { event: "harvest"; data: HarvestView };

/**
 * `conversationViews()` is not a package export. `Conversation.watch` is the same
 * `WatchHandle<ConversationView>` the view mount serves.
 */
export async function chatEventResponse(
	harness: Harness,
	conversationId: ConversationId,
	chatKey: string,
	signal: AbortSignal,
	models: MutableModels,
): Promise<Response> {
	const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
	const conversation = await harness.conversation(conversationId, context);
	if (!conversation) return jsonError(404, "No such chat.");
	const watch = await conversation.watch(context);
	const notesWatch = await harness.watchDoc(HarvestNotesDoc, context);
	let closed = false;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const encoder = new TextEncoder();
			const send = (frame: Frame) => {
				if (closed) return;
				controller.enqueue(
					encoder.encode(
						`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`,
					),
				);
			};
			let notes = notesFor(notesWatch?.value, chatKey);
			const seen = new Set<string>();
			let latest = watch.value;
			const emit = frameEmitter(send, () => ({
				notes,
				contextPercent: contextPercent(latest, models),
			}));
			const publish = (next: HarvestView[]) => {
				for (const note of next) {
					const id = `${note.at}:${note.when}`;
					if (seen.has(id)) continue;
					seen.add(id);
					send({ event: "harvest", data: note });
				}
				notes = next;
				emit(latest);
			};
			publish(notes);
			watch.start(async (value) => {
				latest = value;
				emit(value);
			});
			void notesWatch?.start(async (value) => {
				publish(notesFor(value, chatKey));
			});
			const stop = () => {
				if (closed) return;
				closed = true;
				void watch.stop();
				void notesWatch?.stop();
				try {
					controller.close();
				} catch {
					// The client already went away.
				}
			};
			signal.addEventListener("abort", stop, { once: true });
			void watch.closed.then(stop);
		},
		cancel() {
			closed = true;
			void watch.stop();
			void notesWatch?.stop();
		},
	});
	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		},
	});
}

function jsonError(status: number, error: string): Response {
	return Response.json({ error }, { status });
}

function notesFor(
	value: { notes?: HarvestNote[] } | null | undefined,
	chatKey: string,
): HarvestView[] {
	return (value?.notes ?? [])
		.filter((note) => note.chatKey === chatKey)
		.map((note) => ({ at: note.at, files: note.files, when: note.when }));
}

function contextPercent(
	view: ConversationView,
	models: MutableModels,
): number | undefined {
	const usage = view.docs["pi.usage"] as
		| { models?: Record<string, { input?: number }> }
		| undefined;
	const agent = view.docs["pi.agent"] as
		| { model?: { provider: string; modelId: string } }
		| undefined;
	const model = agent?.model;
	if (!usage?.models || !model) return undefined;
	const input = usage.models[`${model.provider}/${model.modelId}`]?.input;
	if (typeof input !== "number") return undefined;
	const window = models.getModel(model.provider, model.modelId)?.contextWindow;
	if (!window) return undefined;
	return Math.max(0, Math.min(100, Math.round((input / window) * 100)));
}

/** First call sends the current state and no delta. Later calls send what changed. */
export function frameEmitter(
	send: (frame: Frame) => void,
	extras: () => { notes: HarvestView[]; contextPercent?: number },
): (view: ConversationView) => void {
	let primed = false;
	let lastPartial = "";
	let lastBusy = false;
	let lastMessages = "";
	let lastTools = "";
	let lastError = "";
	return (view) => {
		const live = view.docs["pi.live"] as LiveState | undefined;
		const busy = live?.run !== undefined;
		const partial = partialText(live?.generation?.message);
		const tools = liveTools(live);
		const messages = projectEntries(view.entries as readonly EntryRecord[]);
		const messagesKey = JSON.stringify(messages);
		const toolsKey = JSON.stringify(tools);
		const extra = extras();
		const state: ChatState = {
			busy,
			messages,
			tools,
			notes: extra.notes,
			...(partial ? { partial } : {}),
			...(extra.contextPercent === undefined
				? {}
				: { contextPercent: extra.contextPercent }),
		};
		const grew =
			primed &&
			partial.startsWith(lastPartial) &&
			partial.length > lastPartial.length;
		const partialReplaced = primed && partial !== lastPartial && !grew;
		if (
			!primed ||
			messagesKey !== lastMessages ||
			busy !== lastBusy ||
			partialReplaced
		)
			send({ event: "state", data: state });
		else if (grew)
			send({
				event: "delta",
				data: { text: partial.slice(lastPartial.length) },
			});
		if (primed && toolsKey !== lastTools) {
			const previous = new Map<string, string>(
				JSON.parse(lastTools || "[]").map((tool: ToolChip) => [
					`${tool.name}:${tool.status}`,
					tool.status,
				]),
			);
			for (const tool of tools) {
				if (previous.get(`${tool.name}:${tool.status}`) === undefined)
					send({ event: "tool", data: tool });
			}
		}
		if (primed && lastBusy && !busy) send({ event: "done", data: {} });
		const retry = live?.generation?.retry?.error;
		const failed =
			retry || latestAssistantError(view.entries as readonly EntryRecord[]);
		if (failed && failed !== lastError)
			send({ event: "error", data: { message: failed } });
		primed = true;
		lastPartial = partial;
		lastBusy = busy;
		lastMessages = messagesKey;
		lastTools = toolsKey;
		if (failed) lastError = failed;
	};
}
