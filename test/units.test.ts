import { describe, expect, it } from "bun:test";
import { Writable } from "node:stream";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { slugifyBotName } from "../src/channels/bot-slug.ts";
import { chatKey } from "../src/channels/telegram/chats.ts";
import { parseCommand } from "../src/channels/telegram/commands.ts";
import { chunkText } from "../src/channels/telegram/deliver.ts";
import { requestIdOf } from "../src/channels/telegram/poller.ts";
import { liveTools, projectEntries } from "../src/channels/web/transcript.ts";
import { parseUserIds } from "../src/config.ts";
import { dayLine } from "../src/extensions/identity.ts";
import { parseDescription, parseSlug } from "../src/extensions/knowledge.ts";
import {
	applyServerTools,
	attachNativeTools,
	noteServerTool,
} from "../src/extensions/provider-tools.ts";
import { botIdFromCwd } from "../src/extensions/self-tools/index.ts";
import {
	parseScheduleCreate,
	parseScheduleUpdate,
} from "../src/extensions/self-tools/schedules.ts";
import { resolveProviderId } from "../src/harness/login.ts";
import { parseModelRef } from "../src/harness/models.ts";
import { getLogger, setupLogger } from "../src/log.ts";
import { nextCron, parseCron } from "../src/schedules/cron.ts";
import { defined } from "./support.ts";

// Unit tests only for small pure helpers; behaviour is covered by test/flows/.
describe("pure helpers", () => {
	it("maps login aliases", () => {
		expect(resolveProviderId("grok")).toBe("xai");
		expect(resolveProviderId("XAI")).toBe("xai");
	});

	it("parses commands, including /cmd@Bot, and ignores other bots and unknown commands", () => {
		expect(parseCommand("/new")).toEqual({ name: "new", args: "" });
		expect(parseCommand("/new@pi_test_bot  carry on", "pi_test_bot")).toEqual({
			name: "new",
			args: "carry on",
		});
		expect(parseCommand("/new@other_bot", "pi_test_bot")).toBeUndefined();
		expect(parseCommand("/frobnicate")).toBeUndefined();
		expect(parseCommand("hello /new")).toBeUndefined();
	});

	it("promotes xAI catalog functions to server tools and leaves other providers alone", () => {
		const body = {
			model: "grok",
			tools: [
				{ type: "function", name: "read", parameters: {} },
				{ type: "function", name: "web.search", parameters: {} },
				{ type: "function", name: "web.fetch", parameters: {} },
				{ type: "function", name: "x.search", parameters: {} },
				{ type: "function", name: "code.execute", parameters: {} },
			],
		};
		expect(attachNativeTools("xai", body)).toEqual({
			model: "grok",
			tools: [
				{ type: "function", name: "read", parameters: {} },
				{ type: "web_search" },
				{ type: "function", name: "web.fetch", parameters: {} },
				{ type: "x_search" },
				{ type: "code_interpreter" },
			],
		});
		expect(attachNativeTools("faux", body)).toBe(body);
		expect(attachNativeTools("xai", { input: "hi" })).toEqual({ input: "hi" });
	});

	it("parses model refs whose id contains slashes", () => {
		expect(parseModelRef("openrouter/anthropic/some-model")).toEqual({
			provider: "openrouter",
			modelId: "anthropic/some-model",
		});
		expect(() => parseModelRef("nope")).toThrow(/provider/);
	});

	it("parses the allowlist", () => {
		expect([...parseUserIds("1, 2 3")]).toEqual([1, 2, 3]);
		expect(parseUserIds("").size).toBe(0);
		expect(() => parseUserIds("abc")).toThrow();
	});

	it("builds keys", () => {
		expect(chatKey("default", { chatId: -100 })).toBe(
			"default:tg:general:-100",
		);
		expect(chatKey("default", { chatId: -100, threadId: 7 })).toBe(
			"default:tg:general:-100:7",
		);
		expect(requestIdOf(-100, 42)).toBe("tg:-100:42");
	});

	it("slugifies a bot name", () => {
		expect(slugifyBotName("  Hello, World!! ")).toBe("hello-world");
		expect(slugifyBotName("A")).toBe("a");
		expect(slugifyBotName("-Nope-")).toBe("nope");
		expect(slugifyBotName("---")).toBeUndefined();
		expect(slugifyBotName("")).toBeUndefined();
		expect(slugifyBotName("a".repeat(40))).toBe("a".repeat(32));
		expect(slugifyBotName(`${"a".repeat(31)}!!!extra`)).toBe("a".repeat(31));
	});

	it("reads a bot id only from that bot's folder", () => {
		const home = "/data";
		expect(botIdFromCwd(home, "/data/bots/default")).toBe("default");
		expect(botIdFromCwd(home, "/data/bots/persona-2")).toBe("persona-2");
		expect(botIdFromCwd(home, "/data/bots/default/knowledge")).toBeUndefined();
		expect(botIdFromCwd(home, "/data/other")).toBeUndefined();
		expect(botIdFromCwd(home, "/data/bots/../default")).toBeUndefined();
		expect(botIdFromCwd(home, undefined)).toBeUndefined();
	});

	it("rejects a schedule the model did not specify cleanly", () => {
		expect(parseScheduleCreate({ text: "  " })).toEqual({
			ok: false,
			error: "Message is missing.",
		});
		expect(parseScheduleCreate({ text: "hi", cron: "nope", when: 1 })).toEqual({
			ok: false,
			error: "Pass cron or when, not both.",
		});
		expect(parseScheduleCreate({ text: "hi" })).toEqual({
			ok: false,
			error: "Pass a five-field cron or a when timestamp.",
		});
		expect(parseScheduleCreate({ text: "hi", cron: "* * *" })).toEqual({
			ok: false,
			error: "Cron must be five fields.",
		});
		expect(parseScheduleCreate({ text: "hi", when: Number.NaN })).toEqual({
			ok: false,
			error: "When is not a time.",
		});
		expect(
			parseScheduleCreate({ text: "hi", cron: "0 9 * * 1", target: "fork" }),
		).toEqual({
			ok: true,
			text: "hi",
			targetMode: "fork",
			when: { cron: "0 9 * * 1" },
		});
	});

	it("rejects a schedule update the model did not specify cleanly", () => {
		expect(parseScheduleUpdate({})).toEqual({
			ok: false,
			error: "Schedule id is missing.",
		});
		expect(parseScheduleUpdate({ id: "u-1" })).toEqual({
			ok: false,
			error: "Nothing to update.",
		});
		expect(
			parseScheduleUpdate({ id: "u-1", cron: "0 9 * * *", when: 1 }),
		).toEqual({
			ok: false,
			error: "Pass cron or when, not both.",
		});
		expect(parseScheduleUpdate({ id: "u-1", cron: "nope" })).toEqual({
			ok: false,
			error: "Cron must be five fields.",
		});
		expect(parseScheduleUpdate({ id: "u-1", name: "x".repeat(81) })).toEqual({
			ok: false,
			error: "Name is too long.",
		});
		expect(
			parseScheduleUpdate({
				id: " u-1 ",
				text: "Later",
				name: "  Morning ",
				enabled: false,
				cron: "0 9 * * 1",
			}),
		).toEqual({
			ok: true,
			id: "u-1",
			text: "Later",
			name: "Morning",
			enabled: false,
			when: { cron: "0 9 * * 1" },
		});
	});

	it("parses bot and knowledge slugs", () => {
		expect(parseSlug("default", "bot")).toBe("default");
		expect(parseSlug("a".repeat(32), "bot")).toBe("a".repeat(32));
		expect(parseSlug("a".repeat(33), "bot")).toBeUndefined();
		expect(parseSlug("-nope", "bot")).toBeUndefined();
		expect(parseSlug("A", "bot")).toBeUndefined();
		expect(parseSlug("people", "knowledge")).toBe("people");
		expect(parseSlug("a".repeat(64), "knowledge")).toBe("a".repeat(64));
		expect(parseSlug("a".repeat(65), "knowledge")).toBeUndefined();
		expect(parseSlug("", "knowledge")).toBeUndefined();
	});

	it("parses a one-line knowledge description", () => {
		expect(
			parseDescription(
				"---\ndescription: People Lior mentions.\n---\n\nBody.\n",
			),
		).toBe("People Lior mentions.");
		expect(
			parseDescription(`---\ndescription: ${"x".repeat(240)}\n---\n`),
		).toBe("x".repeat(240));
		expect(
			parseDescription(`---\ndescription: ${"x".repeat(241)}\n---\n`),
		).toBeUndefined();
		expect(parseDescription("---\ndescription:\n---\n")).toBeUndefined();
		expect(
			parseDescription("---\ndescription: one\nkind: two\n---\n"),
		).toBeUndefined();
		expect(parseDescription("no frontmatter")).toBeUndefined();
		expect(
			parseDescription("---\ndescription: line one\nline two\n---\n"),
		).toBeUndefined();
	});

	it("chunks long replies under Telegram's limit", () => {
		const text = Array.from(
			{ length: 300 },
			(_, i) => `line ${i} ${"x".repeat(40)}`,
		).join("\n");
		const chunks = chunkText(text);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(4000);
		expect(chunks.join("\n")).toBe(text);
		expect(chunkText("short")).toEqual(["short"]);
	});

	it("pretty-prints structured logs to the configured stream", () => {
		const lines: string[] = [];
		const stream = new Writable({
			write(chunk, _enc, callback) {
				lines.push(String(chunk));
				callback();
			},
		});
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
		setupLogger({ type: "silent" });
	});

	it("parses five-field cron and rejects the rest", () => {
		const daily = parseCron("0 8 * * *");
		expect(daily?.minute.has(0)).toBe(true);
		expect(daily?.hour.has(8)).toBe(true);
		expect(daily?.weekday.size).toBe(7);
		const stepped = parseCron("*/15 0 1,15 1-3 1-5");
		expect([...(stepped?.minute ?? [])].sort((a, b) => a - b)).toEqual([
			0, 15, 30, 45,
		]);
		expect([...(stepped?.day ?? [])].sort((a, b) => a - b)).toEqual([1, 15]);
		expect([...(stepped?.month ?? [])].sort((a, b) => a - b)).toEqual([
			1, 2, 3,
		]);
		expect([...(stepped?.weekday ?? [])].sort((a, b) => a - b)).toEqual([
			1, 2, 3, 4, 5,
		]);
		expect(parseCron("0 8 * *")).toBeUndefined();
		expect(parseCron("0 8 * * * *")).toBeUndefined();
		expect(parseCron("0 8 * * MON")).toBeUndefined();
		expect(parseCron("@daily")).toBeUndefined();
		expect(parseCron("60 8 * * *")).toBeUndefined();
		expect(parseCron("0 24 * * *")).toBeUndefined();
		expect(parseCron("0 8 32 * *")).toBeUndefined();

		const zone = "Asia/Jerusalem";
		const after = Date.parse("2026-10-10T12:00:00Z");
		const sunday = defined(
			nextCron(defined(parseCron("0 0 * * 0"), "cron"), after, zone),
			"sunday",
		);
		expect(sunday).toBe(
			defined(
				nextCron(defined(parseCron("0 0 * * 7"), "cron"), after, zone),
				"sunday",
			),
		);
		expect(sunday).toBeGreaterThan(after);
		const weekday = new Intl.DateTimeFormat("en-US", {
			timeZone: zone,
			weekday: "short",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		}).format(new Date(sunday));
		expect(weekday.startsWith("Sun")).toBe(true);
		expect(weekday.endsWith("00")).toBe(true);

		const quarter = defined(
			nextCron(defined(parseCron("*/15 * * * *"), "cron"), after, zone),
			"quarter",
		);
		const minute = Number(
			new Intl.DateTimeFormat("en-US", {
				timeZone: zone,
				minute: "2-digit",
			}).format(new Date(quarter)),
		);
		expect(minute % 15).toBe(0);
		expect(quarter - after).toBeLessThanOrEqual(15 * 60 * 1000);
	});

	it("keeps a provider web search on the assistant message", () => {
		const found = new Map();
		noteServerTool(found, {
			type: "response.output_item.done",
			item: {
				type: "web_search_call",
				id: "ws_hourly",
				status: "completed",
				action: { type: "search", query: "Jerusalem hourly weather" },
			},
		});
		const message = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Jerusalem – last 5 hours" }],
		};
		applyServerTools(message as never, found);
		const [item] = projectEntries([
			{ id: 110, kind: "pi.assistant", model: [message] } as never,
		]);
		expect(item).toMatchObject({
			type: "assistant",
			id: 110,
			text: "Jerusalem – last 5 hours",
			segments: [
				{ type: "text", text: "Jerusalem – last 5 hours" },
				{
					type: "tool",
					name: "web.search",
					status: "done",
					detail: {
						callId: "ws_hourly",
						arguments: { type: "search", query: "Jerusalem hourly weather" },
					},
				},
			],
		});
	});

	it("projects an assistant message with thinking, tool calls, and text into a single block", () => {
		const entries = [
			{
				id: 153,
				kind: "pi.assistant",
				model: [
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "", thinkingSignature: "sig_abc" },
							{ type: "text", text: "Top headlines" },
							{
								type: "serverTool",
								id: "ws_search_1",
								name: "web.search",
								arguments: { query: "breaking news" },
								status: "done",
							},
						],
					},
				],
			},
		] as unknown as EntryRecord[];
		const items = projectEntries(entries);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			type: "assistant",
			id: 153,
			text: "Top headlines",
			segments: [
				{ type: "thinking", thinking: "", signature: "sig_abc" },
				{ type: "text", text: "Top headlines" },
				{
					type: "tool",
					name: "web.search",
					status: "done",
					detail: {
						callId: "ws_search_1",
						arguments: { query: "breaking news" },
					},
				},
			],
		});
	});

	it("marks a failed tool call and keeps its arguments and result", () => {
		const callId =
			"call-605b7dda-ee45-4aca-95df-0adce23cbb89-0|fc_a3277a76-7f6f-91c1-a223-cbe066a6c91a_0";
		const entries = [
			{
				id: 61,
				kind: "pi.assistant",
				model: [
					{
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: callId,
								name: "read",
								arguments: { path: "knowledge/SOUL.md" },
							},
						],
					},
				],
			},
			{
				id: 64,
				kind: "pi.tool-result",
				model: [
					{
						role: "toolResult",
						toolCallId: callId,
						toolName: "read",
						isError: true,
						content: [
							{
								type: "text",
								text: "<harness>\n[error] ENOENT\n</harness>",
							},
						],
					},
				],
			},
		] as unknown as EntryRecord[];
		const [item] = projectEntries(entries);
		expect(item).toMatchObject({
			type: "assistant",
			id: 61,
			segments: [
				{
					type: "tool",
					name: "read",
					status: "error",
					detail: {
						callId,
						arguments: { path: "knowledge/SOUL.md" },
						result: "<harness>\n[error] ENOENT\n</harness>",
					},
				},
			],
		});
		const live = liveTools(
			{
				tools: [
					{
						callId,
						name: "read",
						status: "done",
						entry: 64 as EntryRecord["id"],
					},
				],
			},
			entries,
		);
		expect(live[0]?.status).toBe("error");
		expect(live[0]?.detail.result).toContain("ENOENT");
	});

	it("renders a daily date line", () => {
		expect(dayLine("Asia/Jerusalem", new Date("2026-10-09T22:30:00Z"))).toBe(
			"Today is 2026-10-10 (Saturday), time zone Asia/Jerusalem.",
		);
	});
});
