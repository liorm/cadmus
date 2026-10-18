import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { EntryId, Harness } from "@earendil-works/pi-durable";
import { listChats, webChatKey } from "../channels/telegram/chats.ts";
import { getLogger } from "../log.ts";
import type { BotRuntime } from "../runtime.ts";
import type { Schedule } from "./service.ts";

/**
 * What a due schedule does. Chat and new-chat go through a bot runtime.
 * A user fork stays with the storage owner. Harvest is a task phase, not this path.
 */
export async function dispatchFire(options: {
	schedule: Schedule;
	requestId: string;
	harness: Harness;
	runtime(botId: string): BotRuntime | undefined;
}): Promise<void> {
	const { schedule, requestId } = options;
	const log = getLogger().child({
		bot: schedule.botId,
		schedule: schedule.id,
		requestId,
		mode: schedule.target.mode,
	});
	const runtime = options.runtime(schedule.botId);
	if (!runtime) {
		log.warn("schedule fire skipped: bot runtime missing");
		return;
	}
	const target = schedule.target;
	if (target.mode === "chat") {
		log.debug("schedule fire into chat", { chat: target.chatId });
		await runtime.submit(target.chatId, requestId, schedule.text);
		return;
	}
	if (target.mode === "new-chat") {
		const chat = await runtime.createChat(
			webChatKey(schedule.botId, newChatId()),
		);
		log.debug("schedule fire into new chat", { chat: chat.key });
		await runtime.submit(chat.key, requestId, schedule.text);
		return;
	}
	log.debug("schedule fork fire", { chat: target.chatId });
	await forkOnly(options.harness, schedule, requestId);
}

function newChatId(): string {
	return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

async function forkOnly(
	harness: Harness,
	schedule: Schedule,
	requestId: string,
): Promise<void> {
	const target = schedule.target;
	if (target.mode !== "fork") return;
	const chat = (await listChats(harness)).find(
		(item) => item.key === target.chatId && item.botId === schedule.botId,
	);
	if (!chat) return;
	const parent = await harness.conversation(
		chat.conversationId,
		BACKGROUND_CONTEXT,
	);
	if (!parent) return;
	let at = target.at as EntryId | undefined;
	if (at === undefined) {
		const page = await parent.entries(
			{ order: "descending" },
			1,
			undefined,
			BACKGROUND_CONTEXT,
		);
		at = page.items[0]?.id;
	}
	if (at === undefined) return;
	const child = await parent.fork(
		at,
		{ ownership: { kind: "ownerless" } },
		BACKGROUND_CONTEXT,
	);
	const submission = await child.submit(
		{ type: "input", content: schedule.text, requestId, whenBusy: "steer" },
		BACKGROUND_CONTEXT,
	);
	await submission.wait(BACKGROUND_CONTEXT);
}
