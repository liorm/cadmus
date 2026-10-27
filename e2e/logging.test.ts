import { env, runDurableObjectAlarm } from "cloudflare:test";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
	chatFields,
	familyFields,
	getLogger,
	type Logger,
	parseLogLevel,
	setupLogger,
} from "../packages/worker/src/log.js";
import { sendRpc, uniqueAccountId } from "./helpers.js";

describe("Structured Logging System (`src/log.ts`)", () => {
	it("pretty-prints structured logs to the configured stream, supports colors, and supports child bindings", () => {
		const lines: string[] = [];
		const stream = new Writable({
			write(chunk, _enc, callback) {
				lines.push(String(chunk));
				callback();
			},
		});
		const accountId = uniqueAccountId("log-child");
		const coloredAccountId = uniqueAccountId("log-color");
		try {
			setupLogger({ type: "console", level: "info", stream, colors: false });
			const log = getLogger();
			log.debug("hidden");
			log.info("started", { model: "xai/grok-4.7", home: "/data/bot home" });
			log.error("shutdown failed", { error: new Error("boom") });
			expect(lines.some((line) => line.includes("hidden"))).toBe(false);
			expect(lines[0]).toMatch(
				/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} INFO {2}started model=xai\/grok-4\.7 home="\/data\/bot home"\n$/,
			);
			expect(lines[1]).toContain("ERROR shutdown failed error=boom");
			expect(lines[1]).toContain("Error: boom");

			// Colored output
			lines.length = 0;
			setupLogger({ type: "console", level: "info", stream, colors: true });
			getLogger().info("colored line", { account: coloredAccountId });
			expect(lines[0]).toContain("\x1b[36mINFO \x1b[0m colored line");
			expect(lines[0]).toContain("account=");
			expect(lines[0]).toContain(coloredAccountId);

			// Child logger binding
			lines.length = 0;
			setupLogger({ type: "console", level: "debug", stream, colors: false });
			expect(parseLogLevel("DEBUG")).toBe("debug");
			expect(parseLogLevel("bogus")).toBe("debug");
			expect(parseLogLevel(undefined)).toBe("debug");
			getLogger()
				.child(familyFields({ accountId, familyId: "fam-1" }))
				.child(
					chatFields({ key: "default:web:1", conversationId: 42, botId: "b1" }),
				)
				.debug("chat input admitted", { requestId: "web:1", chars: 12 });

			expect(lines[0]).toMatch(/ DEBUG chat input admitted /);
			expect(lines[0]).toContain(`account=${accountId}`);
			expect(lines[0]).toContain("family=fam-1");
			expect(lines[0]).toContain("chat=default:web:1");
			expect(lines[0]).toContain("session=42");
			expect(lines[0]).toContain("bot=b1");
			expect(lines[0]).toContain("requestId=web:1");
		} finally {
			setupLogger({ type: "silent" });
		}
	});

	it("supports plugging in a custom logger implementation via setupLogger({ type: 'custom', logger })", () => {
		const captured: {
			level: string;
			message: string;
			fields?: Record<string, unknown>;
		}[] = [];
		const makeCustom = (bound: Record<string, unknown> = {}): Logger => ({
			debug: (message, fields) =>
				captured.push({
					level: "debug",
					message,
					fields: { ...bound, ...fields },
				}),
			info: (message, fields) =>
				captured.push({
					level: "info",
					message,
					fields: { ...bound, ...fields },
				}),
			warn: (message, fields) =>
				captured.push({
					level: "warn",
					message,
					fields: { ...bound, ...fields },
				}),
			error: (message, fields) =>
				captured.push({
					level: "error",
					message,
					fields: { ...bound, ...fields },
				}),
			child: (fields) => makeCustom({ ...bound, ...fields }),
		});

		try {
			setupLogger({ type: "custom", logger: makeCustom() });
			getLogger()
				.child({ service: "cadmus" })
				.info("custom sink active", { ok: true });
			expect(captured).toEqual([
				{
					level: "info",
					message: "custom sink active",
					fields: { service: "cadmus", ok: true },
				},
			]);
		} finally {
			setupLogger({ type: "silent" });
		}
	});

	it("emits structured logs across Worker routing, CadmusBotFamilyDO turns, out-of-band /status, and idle harvest", async () => {
		const lines: string[] = [];
		const stream = new Writable({
			write(chunk, _enc, callback) {
				lines.push(String(chunk));
				callback();
			},
		});
		setupLogger({ type: "console", level: "debug", stream, colors: false });

		try {
			const scope = {
				accountId: uniqueAccountId("logs"),
				familyId: "default",
			};

			await sendRpc("family.update", { harvestDelayMs: 5000 }, scope);
			await sendRpc("bot.create", { slug: "log-bot", name: "Log Bot" }, scope);
			await sendRpc(
				"chat.create",
				{ botId: "log-bot", key: "log-chat" },
				scope,
			);
			await sendRpc(
				"turn.submit",
				{
					chatKey: "log-chat",
					text: "Hello logger [remember: Structured logs work]",
				},
				scope,
			);
			// Second turn before harvest fires: reschedules harvest, should NOT log "harvest armed" again
			await sendRpc(
				"turn.submit",
				{
					chatKey: "log-chat",
					text: "Second turn before harvest",
				},
				scope,
			);
			const armedCount = lines.filter((line) =>
				line.includes("DEBUG harvest armed"),
			).length;
			expect(armedCount).toBe(1);

			await sendRpc(
				"turn.command",
				{ chatKey: "log-chat", command: "/status" },
				scope,
			);

			await sendRpc(
				"schedule.update",
				{
					id: "harvest:log-chat",
					kind: "absolute",
					input: Date.now() - 10,
				},
				scope,
			);
			const doId = env.CADMUS_BOT_FAMILY.idFromName(
				`cadmus:${scope.accountId}:${scope.familyId}`,
			);
			const stub = env.CADMUS_BOT_FAMILY.get(doId);
			await runDurableObjectAlarm(stub);

			const deadline = Date.now() + 2000;
			while (
				Date.now() < deadline &&
				!lines.join("").includes("DEBUG harvest wrote knowledge")
			) {
				await new Promise((r) => setTimeout(r, 50));
			}

			const combined = lines.join("");
			expect(combined).toContain("INFO  bot created");
			expect(combined).toContain("bot=log-bot");
			expect(combined).toContain("INFO  chat created");
			expect(combined).toContain("chat=log-chat");
			expect(combined).toContain("DEBUG chat input admitted");
			expect(combined).toContain("DEBUG chat turn settled");
			expect(combined).toContain("DEBUG harvest armed");
			expect(combined).toContain("DEBUG harvest fired");
			expect(combined).toContain("DEBUG schedule firing");
			expect(combined).toContain("DEBUG command");
			expect(combined).toContain("name=status");
			expect(combined).toContain("DEBUG harvest wrote knowledge");
		} finally {
			setupLogger({ type: "silent" });
		}
	});
});
