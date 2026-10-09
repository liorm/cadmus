import { Api } from "grammy";

/** The subset of a Telegram `Message` pi-bot reads. grammY's `Message` is assignable to it. */
export type TgMessage = {
	readonly message_id: number;
	readonly message_thread_id?: number;
	readonly is_topic_message?: boolean;
	readonly date: number;
	readonly chat: { readonly id: number; readonly type: string; readonly title?: string };
	readonly from?: { readonly id: number; readonly is_bot?: boolean; readonly first_name?: string; readonly username?: string };
	readonly text?: string;
};

/** The subset of a Telegram `Update` pi-bot reads. grammY's `Update` is assignable to it. */
export type TgUpdate = { readonly update_id: number; readonly message?: TgMessage };

export type SendOptions = { readonly threadId?: number };

/**
 * Everything pi-bot needs from Telegram. Production uses grammY's Bot API client; tests use fakes. Implementations
 * must not retry `sendMessage` on their own: the Bot API has no idempotency key, so a retry can duplicate a reply.
 */
export interface TelegramTransport {
	/** Long poll. Resolves with updates whose `update_id >= offset` (all pending when `offset` is undefined). */
	getUpdates(offset: number | undefined, timeoutSec: number, signal: AbortSignal): Promise<readonly TgUpdate[]>;
	sendMessage(chatId: number, text: string, options: SendOptions): Promise<{ messageId: number }>;
	/** Best-effort "typing…" indicator. */
	sendTyping?(chatId: number, options: SendOptions): Promise<void>;
	/** Bot username, used to accept `/cmd@BotName`. */
	username?(): Promise<string | undefined>;
}

/** grammY-backed transport: raw `getUpdates` long polling, so the update offset is owned by the durable cursor doc. */
export class GrammyTransport implements TelegramTransport {
	readonly api: Api;
	#username?: Promise<string | undefined>;

	/** `apiRoot`: a local Bot API server (default https://api.telegram.org). Uses the runtime's global fetch. */
	constructor(token: string, options: { apiRoot?: string } = {}) {
		this.api = new Api(token, {
			...(options.apiRoot ? { apiRoot: options.apiRoot } : {}),
			fetch: ((input: string, init?: RequestInit) => globalThis.fetch(input, init)) as never,
		});
	}

	async getUpdates(offset: number | undefined, timeoutSec: number, signal: AbortSignal) {
		return this.api.getUpdates(
			{ ...(offset === undefined ? {} : { offset }), timeout: timeoutSec, allowed_updates: ["message"] },
			// grammY types its signal with the abort-controller polyfill; the global AbortSignal works at runtime.
			signal as unknown as Parameters<Api["getUpdates"]>[1],
		);
	}

	async sendMessage(chatId: number, text: string, options: SendOptions) {
		const sent = await this.api.sendMessage(chatId, text, {
			...(options.threadId === undefined ? {} : { message_thread_id: options.threadId }),
			link_preview_options: { is_disabled: true },
		});
		return { messageId: sent.message_id };
	}

	async sendTyping(chatId: number, options: SendOptions) {
		await this.api.sendChatAction(chatId, "typing", {
			...(options.threadId === undefined ? {} : { message_thread_id: options.threadId }),
		});
	}

	username() {
		this.#username ??= this.api.getMe().then(
			(me) => me.username,
			() => undefined,
		);
		return this.#username;
	}
}
