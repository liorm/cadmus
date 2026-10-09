import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { type ConversationId, type ConversationView, type EntryRecord, type Harness, type LiveState } from "@earendil-works/pi-durable";
import { latestAssistantError, liveTools, partialText, projectEntries, type ToolChip, type TranscriptItem } from "./transcript.ts";

export type ChatState = {
	busy: boolean;
	messages: TranscriptItem[];
	partial?: string;
	tools: ToolChip[];
};

type Frame = { event: "state"; data: ChatState } | { event: "delta"; data: { text: string } } | { event: "tool"; data: ToolChip } | { event: "done"; data: Record<string, never> } | { event: "error"; data: { message: string } };

/**
 * `conversationViews()` is not a package export. `Conversation.watch` is the same
 * `WatchHandle<ConversationView>` the view mount serves.
 */
export async function chatEventResponse(harness: Harness, conversationId: ConversationId, signal: AbortSignal): Promise<Response> {
	const conversation = await harness.conversation(conversationId, withAbortSignal(signal, BACKGROUND_CONTEXT));
	if (!conversation) return jsonError(404, "No such chat.");
	const watch = await conversation.watch(withAbortSignal(signal, BACKGROUND_CONTEXT));
	let closed = false;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const encoder = new TextEncoder();
			const send = (frame: Frame) => {
				if (closed) return;
				controller.enqueue(encoder.encode(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`));
			};
			const emit = frameEmitter(send);
			emit(watch.value);
			watch.start(async (value) => {
				emit(value);
			});
			const stop = () => {
				if (closed) return;
				closed = true;
				void watch.stop();
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

/** First call sends the current state and no delta. Later calls send what changed. */
export function frameEmitter(send: (frame: Frame) => void): (view: ConversationView) => void {
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
		const state: ChatState = { busy, messages, tools, ...(partial ? { partial } : {}) };
		const grew = primed && partial.startsWith(lastPartial) && partial.length > lastPartial.length;
		const partialReplaced = primed && partial !== lastPartial && !grew;
		if (!primed || messagesKey !== lastMessages || busy !== lastBusy || partialReplaced) send({ event: "state", data: state });
		else if (grew) send({ event: "delta", data: { text: partial.slice(lastPartial.length) } });
		if (primed && toolsKey !== lastTools) {
			const previous = new Map<string, string>(JSON.parse(lastTools || "[]").map((tool: ToolChip) => [`${tool.name}:${tool.status}`, tool.status]));
			for (const tool of tools) {
				if (previous.get(`${tool.name}:${tool.status}`) === undefined) send({ event: "tool", data: tool });
			}
		}
		if (primed && lastBusy && !busy) send({ event: "done", data: {} });
		const retry = live?.generation?.retry?.error;
		const failed = retry || latestAssistantError(view.entries as readonly EntryRecord[]);
		if (failed && failed !== lastError) send({ event: "error", data: { message: failed } });
		primed = true;
		lastPartial = partial;
		lastBusy = busy;
		lastMessages = messagesKey;
		lastTools = toolsKey;
		if (failed) lastError = failed;
	};
}
