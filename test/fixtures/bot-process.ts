// A real pi-bot process over a file-backed fake Telegram, for kill -9 tests.
//   FIXTURE_DIR/updates.json   updates "Telegram" serves (rewritten by the test)
//   FIXTURE_DIR/sends.jsonl    every sendMessage attempt, appended *before* it resolves
//   FIXTURE_DIR/events.jsonl   lifecycle events: ready, model-call, send-hang, stopped
// FAUX_MODE=hang makes the model never answer; HANG_SEND=1 makes sendMessage never return; REDELIVER=1 ignores offsets.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startApp } from "../../src/app.ts";
import type { SendOptions, TelegramTransport, TgUpdate } from "../../src/channels/telegram/transport.ts";
import { createModels, echoResponse } from "../../src/harness/models.ts";
import { consoleLogger } from "../../src/log.ts";

const dir = process.env.FIXTURE_DIR!;
const home = process.env.PI_BOT_HOME!;
const event = (type: string, data: Record<string, unknown> = {}) =>
	appendFileSync(join(dir, "events.jsonl"), `${JSON.stringify({ type, pid: process.pid, ...data })}\n`);
const never = () => new Promise<never>(() => {});

class FileTransport implements TelegramTransport {
	#messageId = Number(process.env.MESSAGE_ID_BASE ?? 50_000);
	async getUpdates(offset: number | undefined, _timeout: number, signal: AbortSignal) {
		for (;;) {
			if (signal.aborted) throw new Error("aborted");
			let updates: TgUpdate[] = [];
			try {
				updates = JSON.parse(readFileSync(join(dir, "updates.json"), "utf8"));
			} catch {}
			const ready = updates.filter((u) => process.env.REDELIVER === "1" || offset === undefined || u.update_id >= offset);
			if (ready.length && !(process.env.REDELIVER === "1" && this.#served)) {
				this.#served = true;
				return ready;
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	#served = false;
	async sendMessage(chatId: number, text: string, options: SendOptions) {
		appendFileSync(join(dir, "sends.jsonl"), `${JSON.stringify({ chatId, text, ...options, pid: process.pid })}\n`);
		if (process.env.HANG_SEND === "1") {
			event("send-hang", { text });
			return never();
		}
		return { messageId: this.#messageId++ };
	}
}

const models = createModels(async (context) => {
	event("model-call");
	if (process.env.FAUX_MODE === "hang") return never();
	return echoResponse(context);
});

const app = await startApp({
	config: {
		home,
		telegram: { allowedUsers: new Set([1]), pollTimeoutSec: 0 },
		model: { main: { provider: "faux", modelId: "echo" } },
		timeZone: "UTC",
		logLevel: process.env.LOG_LEVEL ?? "warn",
		deliverySweepMs: 200,
	},
	models,
	transport: new FileTransport(),
	log: consoleLogger(process.env.LOG_LEVEL ?? "warn"),
});
event("ready", { unknown: app.unknownAtStartup });
process.on("SIGTERM", () => {
	void app.stop().then(() => {
		event("stopped");
		process.exit(0);
	});
});
