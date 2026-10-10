import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type ConversationId,
	type Cursor,
	defineDoc,
	type EntryId,
	type Harness,
} from "@earendil-works/pi-durable";
import { getLogger } from "../../log.ts";
import { type ChatRecord, hasTelegramAddress, listChats } from "./chats.ts";
import type { TelegramTransport } from "./transport.ts";

/**
 * Delivery receipts (pi-imessage ADR 0003, replies at most once). Every outbound message — a final answer (keyed by
 * its entry id) or a bot notice (keyed `notice:<id>`) — is claimed as `sending` in a commit, sent, then recorded as
 * `sent` or `unknown`. After a crash, `sending` becomes `unknown` and is never resent automatically: a crash in that
 * window can drop a reply, but nothing is ever sent twice.
 */
export type DeliveryStatus = "sending" | "sent" | "unknown";
export type Receipt = {
	status: DeliveryStatus;
	at: number;
	messageIds?: number[];
	error?: string;
};

export const DeliveriesDoc = defineDoc<{
	receipts: Record<string, Receipt>;
	/** Every final answer up to and including this entry has a receipt. */
	scanned?: number;
}>({
	kind: "pi-bot.telegram.deliveries",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ receipts: {} }),
});

/** Telegram's limit is 4096 characters; split on paragraph/line boundaries when possible. */
export function chunkText(text: string, limit = 4000): string[] {
	const chunks: string[] = [];
	let rest = text;
	while (rest.length > limit) {
		let cut = rest.lastIndexOf("\n\n", limit);
		if (cut < limit / 2) cut = rest.lastIndexOf("\n", limit);
		if (cut < limit / 2) cut = rest.lastIndexOf(" ", limit);
		if (cut < limit / 2) cut = limit;
		chunks.push(rest.slice(0, cut).trimEnd());
		rest = rest.slice(cut).trimStart();
	}
	if (rest) chunks.push(rest);
	return chunks;
}

/** The user-visible text of a final answer; undefined for tool-call turns, errors, aborts and empty answers. */
export function finalReplyText(
	message: Message | undefined,
): string | undefined {
	if (
		message?.role !== "assistant" ||
		!["stop", "length"].includes(message.stopReason)
	)
		return undefined;
	if (message.content.some((part) => part.type === "toolCall"))
		return undefined;
	const text = message.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("\n")
		.trim();
	return text || undefined;
}

/** Startup: every receipt still `sending` belonged to a process that died mid-send. Mark it `unknown`; never resend. */
export async function reconcileInterrupted(harness: Harness) {
	const unknown: {
		chat: string;
		conversationId: ConversationId;
		key: string;
	}[] = [];
	for (const chat of await listChats(harness)) {
		const keys = await harness.commit(async (tx) => {
			const deliveries = await tx.doc(DeliveriesDoc, chat.conversationId);
			const changed: string[] = [];
			for (const [key, receipt] of Object.entries(deliveries.receipts)) {
				if (receipt.status !== "sending") continue;
				receipt.status = "unknown";
				receipt.error = "interrupted by restart";
				changed.push(key);
			}
			return changed;
		}, BACKGROUND_CONTEXT);
		for (const key of keys) {
			getLogger().warn(
				`Delivery unknown (interrupted mid-send, not resent): chat ${chat.key} ${key}`,
			);
			unknown.push({
				chat: chat.key,
				conversationId: chat.conversationId,
				key,
			});
		}
	}
	return unknown;
}

type Claim =
	| { kind: "send"; text: string }
	| { kind: "done" }
	| { kind: "blocked" };

export class Deliverer {
	readonly #queues = new Map<string, Promise<void>>();

	private readonly harness: Harness;
	/** General door. Absent when `TELEGRAM_BOT_TOKEN` is unset; `:tg:general:` sends are skipped. */
	private readonly transport?: TelegramTransport;
	readonly #bots = new Map<string, TelegramTransport>();

	constructor(harness: Harness, transport?: TelegramTransport) {
		this.harness = harness;
		this.transport = transport;
	}

	/** The transport for `:tg:bot:` chats. Clearing it skips sends until the token is set again. */
	setBotTransport(
		botId: string,
		transport: TelegramTransport | undefined,
	): void {
		if (transport) this.#bots.set(botId, transport);
		else this.#bots.delete(botId);
	}

	#transportFor(chat: ChatRecord): TelegramTransport | undefined {
		if (chat.key.includes(":tg:bot:"))
			return chat.botId ? this.#bots.get(chat.botId) : undefined;
		return this.transport;
	}

	/** Serialize all delivery work of one chat. */
	#serial<T>(chat: ChatRecord, work: () => Promise<T>): Promise<T> {
		const previous = this.#queues.get(chat.key) ?? Promise.resolve();
		const next = previous.then(work, work);
		const tail = next.then(
			() => {},
			() => {},
		);
		this.#queues.set(chat.key, tail);
		void tail.then(() => {
			if (this.#queues.get(chat.key) === tail) this.#queues.delete(chat.key);
		});
		return next;
	}

	/** Wait for every queued delivery to finish. */
	async idle(): Promise<void> {
		while (this.#queues.size) await Promise.all(this.#queues.values());
	}

	/** Send every committed final answer of the chat that has no receipt yet, oldest first. Web chats are skipped. */
	kick(chat: ChatRecord): Promise<void> {
		if (!hasTelegramAddress(chat) || !this.#transportFor(chat))
			return Promise.resolve();
		return this.#serial(chat, () => this.#deliverAnswers(chat)).catch(
			(error) => {
				getLogger().error(`Delivery sweep failed for chat ${chat.key}`, {
					error,
				});
			},
		);
	}

	async sweepAll(): Promise<void> {
		await Promise.all(
			(await listChats(this.harness))
				.filter(hasTelegramAddress)
				.map((chat) => this.kick(chat)),
		);
	}

	/** A bot-originated message (command reply, error notice) with its own receipt key; sent at most once. */
	notice(
		chat: ChatRecord,
		key: string,
		text: string,
	): Promise<DeliveryStatus | "duplicate"> {
		if (!hasTelegramAddress(chat) || !this.#transportFor(chat))
			return Promise.resolve("duplicate");
		return this.#serial(chat, async () => {
			const receiptKey = `notice:${key}`;
			const claim = await this.harness.commit(async (tx) => {
				const deliveries = await tx.doc(DeliveriesDoc, chat.conversationId);
				if (deliveries.receipts[receiptKey]) return false;
				deliveries.receipts[receiptKey] = { status: "sending", at: Date.now() };
				return true;
			}, BACKGROUND_CONTEXT);
			if (!claim) return "duplicate" as const;
			return this.#send(chat, receiptKey, text);
		});
	}

	async #deliverAnswers(chat: ChatRecord) {
		const scanned = (
			await this.harness.snapshot(
				DeliveriesDoc,
				chat.conversationId,
				BACKGROUND_CONTEXT,
			)
		)?.scanned;
		const conversation = await this.harness.conversation(
			chat.conversationId,
			BACKGROUND_CONTEXT,
		);
		if (!conversation) return;
		const answers: { id: EntryId; text: string }[] = [];
		let last: number | undefined;
		let cursor: Cursor | undefined;
		do {
			const page = await conversation.entries(
				{
					order: "ascending",
					...(scanned === undefined ? {} : { minEntryId: scanned as EntryId }),
				},
				200,
				cursor,
				BACKGROUND_CONTEXT,
			);
			for (const entry of page.items) {
				if (scanned !== undefined && entry.id <= scanned) continue;
				last = entry.id;
				if (!AssistantEntry.is(entry)) continue;
				const text = finalReplyText(entry.model?.[0]);
				if (text) answers.push({ id: entry.id, text });
			}
			cursor = page.next;
		} while (cursor);

		for (const answer of answers) {
			const key = String(answer.id);
			const claim = await this.harness.commit<Claim>(async (tx) => {
				const deliveries = await tx.doc(DeliveriesDoc, chat.conversationId);
				if (deliveries.receipts[key]) return { kind: "done" };
				// Never overtake an earlier in-flight send of this chat.
				if (
					Object.values(deliveries.receipts).some(
						(receipt) => receipt.status === "sending",
					)
				)
					return { kind: "blocked" };
				deliveries.receipts[key] = { status: "sending", at: Date.now() };
				return { kind: "send", text: answer.text };
			}, BACKGROUND_CONTEXT);
			if (claim.kind === "blocked") return;
			if (claim.kind === "send") await this.#send(chat, key, claim.text);
		}
		if (last !== undefined) {
			const upTo = last;
			await this.harness.commit(async (tx) => {
				const deliveries = await tx.doc(DeliveriesDoc, chat.conversationId);
				if (deliveries.scanned === undefined || deliveries.scanned < upTo)
					deliveries.scanned = upTo;
			}, BACKGROUND_CONTEXT);
		}
	}

	/** The effect between the `sending` claim and its outcome. A throw may still have delivered: never retried. */
	async #send(
		chat: ChatRecord,
		key: string,
		text: string,
	): Promise<DeliveryStatus> {
		const transport = this.#transportFor(chat);
		if (chat.chatId === undefined || !transport) return "unknown";
		const messageIds: number[] = [];
		let status: DeliveryStatus = "sent";
		let error: string | undefined;
		try {
			for (const chunk of chunkText(text)) {
				const sent = await transport.sendMessage(chat.chatId, chunk, {
					...(chat.threadId === undefined ? {} : { threadId: chat.threadId }),
				});
				messageIds.push(sent.messageId);
			}
		} catch (caught) {
			status = "unknown";
			error = caught instanceof Error ? caught.message : String(caught);
			getLogger().warn(
				`Delivery unknown (send failed, not retried): chat ${chat.key} ${key}: ${error}`,
			);
		}
		await this.harness.commit(async (tx) => {
			const deliveries = await tx.doc(DeliveriesDoc, chat.conversationId);
			deliveries.receipts[key] = {
				status,
				at: Date.now(),
				messageIds,
				...(error ? { error } : {}),
			};
		}, BACKGROUND_CONTEXT);
		return status;
	}
}
