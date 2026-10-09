// One local HTTP server standing in for every egress API pi-bot talks to:
//   /telegram/bot<token>/<method>   Telegram Bot API (getUpdates long polling, sendMessage, sendChatAction, getMe)
//   /xai-api/v1/responses           xAI Responses API (Grok), streamed as SSE
//   /xai-auth/oauth2/...            xAI OAuth (device code + token/refresh)
// `routeEgress()` (in-process) or `preload.ts` (child processes) rewrites the real hosts to this server, so production
// code runs unchanged down to `fetch`.

export type TgUser = { id: number; first_name: string; username?: string; is_bot?: boolean };
export type TgUpdate = {
	update_id: number;
	message: {
		message_id: number;
		date: number;
		chat: { id: number; type: string };
		from: TgUser;
		text: string;
		message_thread_id?: number;
		is_topic_message?: boolean;
	};
};
export type SentMessage = { chatId: number; text: string; threadId?: number; messageId: number };

const LIVE = "lior";
export const OWNER: TgUser = { id: 1, first_name: "Lior", username: LIVE };
export const STRANGER: TgUser = { id: 999, first_name: "Eve", username: "eve" };
export const CHAT = 100;

const never = () => new Promise<never>(() => {});
const tg = (result: unknown) => Response.json({ ok: true, result });
const tgError = (code: number, description: string) =>
	Response.json({ ok: false, error_code: code, description }, { status: code });

export class FakeTelegram {
	readonly updates: TgUpdate[] = [];
	readonly sent: SentMessage[] = [];
	readonly sendAttempts: { chatId: number; text: string }[] = [];
	readonly typing: number[] = [];
	/** Highest offset the bot has confirmed (every update below it was handled). */
	confirmedOffset = 0;
	polls = 0;
	/** sendMessage never answers (the bot is killed mid-send). */
	hangSend = false;
	/** The next sendMessage fails with HTTP 500 after "maybe" delivering. */
	failNextSend = false;
	#redeliverAll = false;
	#nextUpdateId = 1;
	#nextMessageId = 1;
	#nextSentId = 90_000;
	#wake = new Set<() => void>();

	/** A user writes in a chat. Returns the update. */
	push(text: string, options: { from?: TgUser; chatId?: number; threadId?: number; chatType?: string } = {}): TgUpdate {
		const update: TgUpdate = {
			update_id: this.#nextUpdateId++,
			message: {
				message_id: this.#nextMessageId++,
				date: Math.floor(Date.now() / 1000),
				chat: {
					id: options.chatId ?? CHAT,
					type: options.chatType ?? (options.threadId === undefined && (options.chatId ?? CHAT) > 0 ? "private" : "supergroup"),
				},
				from: options.from ?? OWNER,
				text,
				...(options.threadId === undefined ? {} : { message_thread_id: options.threadId, is_topic_message: true }),
			},
		};
		this.updates.push(update);
		this.#notify();
		return update;
	}

	/** Telegram serves every known update again once, regardless of the confirmed offset (lost offset / restart). */
	redeliverAll() {
		this.#redeliverAll = true;
		this.#notify();
	}

	/** Every pushed update has been confirmed via a later getUpdates offset, i.e. fully handled by the bot. */
	drained(): boolean {
		const last = this.updates.at(-1)?.update_id ?? 0;
		return this.confirmedOffset > last && !this.#redeliverAll;
	}

	texts() {
		return this.sent.map((message) => message.text);
	}

	#notify() {
		for (const wake of this.#wake) wake();
	}

	async handle(method: string, params: Record<string, unknown>): Promise<Response> {
		switch (method) {
			case "getMe":
				return tg({ id: 4242, is_bot: true, first_name: "pi-bot", username: "pi_test_bot" });
			case "getUpdates": {
				this.polls++;
				const offset = typeof params.offset === "number" ? params.offset : 0;
				if (offset > this.confirmedOffset) this.confirmedOffset = offset;
				const deadline = Date.now() + Math.min(Number(params.timeout ?? 0), 2) * 1000;
				for (;;) {
					if (this.#redeliverAll) {
						this.#redeliverAll = false;
						return tg(this.updates);
					}
					const ready = this.updates.filter((update) => update.update_id >= offset);
					if (ready.length || Date.now() >= deadline) return tg(ready);
					await new Promise<void>((resolve) => {
						const wake = () => {
							this.#wake.delete(wake);
							clearTimeout(timer);
							resolve();
						};
						const timer = setTimeout(wake, Math.max(10, deadline - Date.now()));
						this.#wake.add(wake);
					});
				}
			}
			case "sendMessage": {
				const chatId = Number(params.chat_id);
				const text = String(params.text);
				this.sendAttempts.push({ chatId, text });
				if (this.hangSend) return never();
				if (this.failNextSend) {
					this.failNextSend = false;
					return tgError(500, "Internal Server Error");
				}
				const messageId = this.#nextSentId++;
				const threadId = typeof params.message_thread_id === "number" ? params.message_thread_id : undefined;
				this.sent.push({ chatId, text, messageId, ...(threadId === undefined ? {} : { threadId }) });
				return tg({ message_id: messageId, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: "private" }, text });
			}
			case "sendChatAction":
				this.typing.push(Number(params.chat_id));
				return tg(true);
			default:
				return tgError(404, `Not Found: method ${method}`);
		}
	}
}

export type XaiRequest = { authorization: string | null; body: Record<string, unknown> };

function userTexts(body: Record<string, unknown>): string[] {
	const input = Array.isArray(body.input) ? (body.input as Record<string, unknown>[]) : [];
	return input
		.filter((item) => item.role === "user")
		.map((item) =>
			typeof item.content === "string"
				? item.content
				: (item.content as { type: string; text?: string }[]).map((part) => part.text ?? "").join(""),
		);
}

function sse(events: Record<string, unknown>[]): Response {
	const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

export class FakeXai {
	readonly requests: XaiRequest[] = [];
	/** Responses API: answers wait while held. */
	#held: Promise<void> | undefined;
	#release: (() => void) | undefined;
	/** Responses API: never answer (the bot is killed mid-turn). */
	hang = false;
	/** Next responses: an HTTP error instead of an answer. */
	failNext: { status: number; message: string } | undefined;
	/** Override the reply text. Default: `grok(<user messages seen>): <last user text>`. */
	reply: ((body: Record<string, unknown>) => string) | undefined;
	/** Issued OAuth tokens. */
	readonly tokens: { access: string; refresh: string }[] = [];
	readonly oauthRequests: { path: string; form: URLSearchParams }[] = [];
	/** Device-code polls answered "authorization_pending" before approval. */
	pendingPolls = 1;
	#tokenSeq = 0;

	hold() {
		this.#held = new Promise((resolve) => {
			this.#release = resolve;
		});
	}

	release() {
		this.#release?.();
		this.#held = undefined;
	}

	#issue() {
		const seq = ++this.#tokenSeq;
		const token = { access: `xai-access-${seq}`, refresh: `xai-refresh-${seq}` };
		this.tokens.push(token);
		return Response.json({ access_token: token.access, refresh_token: token.refresh, expires_in: 3600, token_type: "Bearer" });
	}

	async handleOAuth(path: string, form: URLSearchParams): Promise<Response> {
		this.oauthRequests.push({ path, form });
		if (path === "/oauth2/device/code")
			return Response.json({
				device_code: "device-xyz",
				user_code: "WXYZ-1234",
				verification_uri: "https://accounts.x.ai/device",
				verification_uri_complete: "https://accounts.x.ai/device?user_code=WXYZ-1234",
				expires_in: 600,
				interval: 1,
			});
		if (path === "/oauth2/token") {
			const grant = form.get("grant_type");
			if (grant === "refresh_token") {
				const known = this.tokens.some((token) => token.refresh === form.get("refresh_token"));
				return known ? this.#issue() : Response.json({ error: "invalid_grant" }, { status: 400 });
			}
			if (this.pendingPolls > 0) {
				this.pendingPolls--;
				return Response.json({ error: "authorization_pending" }, { status: 400 });
			}
			return this.#issue();
		}
		return new Response("not found", { status: 404 });
	}

	async handleResponses(request: Request): Promise<Response> {
		const body = (await request.json()) as Record<string, unknown>;
		this.requests.push({ authorization: request.headers.get("authorization"), body });
		if (this.hang) return never();
		const authorization = request.headers.get("authorization") ?? "";
		const valid = authorization === "Bearer test-api-key" || this.tokens.some((token) => authorization === `Bearer ${token.access}`);
		if (!valid) return Response.json({ error: { message: "Incorrect API key provided", code: "invalid_api_key" } }, { status: 401 });
		if (this.failNext) {
			const failure = this.failNext;
			this.failNext = undefined;
			return Response.json({ error: { message: failure.message, code: "mock_failure" } }, { status: failure.status });
		}
		await this.#held;
		const texts = userTexts(body);
		const text = this.reply?.(body) ?? `grok(${texts.length}): ${texts.at(-1) ?? ""}`;
		const id = `resp_${this.requests.length}`;
		const item = { type: "message", id: `msg_${this.requests.length}`, role: "assistant", status: "completed" };
		return sse([
			{ type: "response.created", response: { id, status: "in_progress" } },
			{ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
			{ type: "response.output_item.done", output_index: 0, item: { ...item, content: [{ type: "output_text", text, annotations: [] }] } },
			{
				type: "response.completed",
				response: { id, status: "completed", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
			},
		]);
	}
}

export class FakeEgress {
	readonly telegram = new FakeTelegram();
	readonly xai = new FakeXai();
	readonly server: ReturnType<typeof Bun.serve>;

	constructor() {
		this.server = Bun.serve({
			port: 0,
			idleTimeout: 0,
			fetch: async (request) => {
				const url = new URL(request.url);
				const tgMatch = /^\/telegram\/bot[^/]+\/([A-Za-z]+)$/.exec(url.pathname);
				if (tgMatch) {
					const text = await request.text();
					const params = text ? (request.headers.get("content-type")?.includes("json") ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text))) : {};
					return this.telegram.handle(tgMatch[1]!, params);
				}
				if (url.pathname === "/xai-api/v1/responses") return this.xai.handleResponses(request);
				if (url.pathname.startsWith("/xai-auth/"))
					return this.xai.handleOAuth(url.pathname.slice("/xai-auth".length), new URLSearchParams(await request.text()));
				return new Response(`unmocked egress: ${request.method} ${url.pathname}`, { status: 599 });
			},
		});
	}

	get url() {
		return `http://127.0.0.1:${this.server.port}`;
	}

	stop() {
		this.xai.release();
		this.server.stop(true);
	}
}
