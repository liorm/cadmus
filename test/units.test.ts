import { describe, expect, it } from "bun:test";
import { Writable } from "node:stream";
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import { catalogGroup, toolCatalog } from "../src/channels/bot-catalog.ts";
import { slugifyBotName } from "../src/channels/bot-slug.ts";
import { explicitSlugError } from "../src/channels/bots.ts";
import { chatKey } from "../src/channels/telegram/chats.ts";
import { parseCommand } from "../src/channels/telegram/commands.ts";
import { chunkText } from "../src/channels/telegram/deliver.ts";
import { requestIdOf } from "../src/channels/telegram/poller.ts";
import { liveTools, projectEntries } from "../src/channels/web/transcript.ts";
import { parseUserIds } from "../src/config.ts";
import { dayLine, soulWithName } from "../src/extensions/identity.ts";
import {
	excerptSoul,
	formatSearchCatalog,
	parseSearchAnswer,
	SEARCH_BOT_CAP,
	SOUL_EXCERPT,
} from "../src/extensions/internal/match.ts";
import {
	formatKnowledge,
	KNOWLEDGE_FIELDS,
	parseCategoryField,
	parseDescription,
	parseDescriptionField,
	parseKnowledge,
	parseKnowledgeBody,
	parseKnowledgeWrite,
	parseSlug,
} from "../src/extensions/knowledge.ts";
import {
	formatMemory,
	MEMORY_BODY_MAX,
	parseMemory,
	parseMemoryWrite,
} from "../src/extensions/memory.ts";
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
import { buildRegistry } from "../src/harness/registry.ts";
import { getLogger, parseLogLevel, setupLogger } from "../src/log.ts";
import { answerHasStarted } from "../src/runtime.ts";
import { nextCron, parseCron } from "../src/schedules/cron.ts";
import { defined } from "./support.ts";

// Unit tests only for small pure helpers; behaviour is covered by test/flows/.
describe("pure helpers", () => {
	it("maps login aliases", () => {
		expect(resolveProviderId("grok")).toBe("xai");
		expect(resolveProviderId("XAI")).toBe("xai");
	});

	it("lists registry tools as the dialog catalog", () => {
		expect(catalogGroup("pi-bot.knowledge")).toBe("Knowledge");
		expect(catalogGroup("pi-bot.self")).toBe("Schedules");
		expect(catalogGroup("pi-bot.internal")).toBe("Internal");
		expect(catalogGroup("pi-bot.web")).toBe("Web");
		const { registry } = buildRegistry({ home: "/tmp", timeZone: "UTC" });
		const catalog = toolCatalog(registry);
		expect(catalog.map((tool) => tool.name)).toEqual(
			registry
				.snapshot()
				.tools()
				.map((entry) => entry.tool.name),
		);
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

	it("rejects an explicit bot slug that is illegal or taken", () => {
		expect(explicitSlugError("researcher", new Set())).toBeUndefined();
		expect(explicitSlugError("Bad", new Set())).toBe("Slug is not a bot id.");
		expect(explicitSlugError("researcher", new Set(["researcher"]))).toBe(
			"Slug is taken.",
		);
	});

	it("parses a search answer as a catalog slug, none, or invalid", () => {
		const slugs = ["researcher", "null"];
		expect(parseSearchAnswer("  researcher  ", slugs)).toEqual({
			kind: "slug",
			slug: "researcher",
		});
		expect(parseSearchAnswer("", slugs)).toEqual({ kind: "none" });
		expect(parseSearchAnswer("  \n", slugs)).toEqual({ kind: "none" });
		expect(parseSearchAnswer("NULL", ["researcher"])).toEqual({ kind: "none" });
		expect(parseSearchAnswer("null", slugs)).toEqual({
			kind: "slug",
			slug: "null",
		});
		expect(parseSearchAnswer("resercher", slugs)).toEqual({ kind: "invalid" });
		expect(parseSearchAnswer("none", slugs)).toEqual({ kind: "invalid" });
		expect(parseSearchAnswer("the researcher bot", slugs)).toEqual({
			kind: "invalid",
		});
	});

	it("caps the search catalog and keeps slugs in order", () => {
		expect(excerptSoul(` ${"a".repeat(SOUL_EXCERPT + 5)} `)).toHaveLength(
			SOUL_EXCERPT + 1,
		);
		const bots = Array.from({ length: SEARCH_BOT_CAP + 2 }, (_, index) => ({
			slug: `b${String(index).padStart(2, "0")}`,
			name: `Bot ${index}`,
			model: "xai/grok",
			soul: "",
		}));
		bots.push({
			slug: "aaa",
			name: "First",
			model: "xai/grok",
			soul: "Hello",
		});
		const catalog = formatSearchCatalog(bots);
		expect(catalog.slugs).toHaveLength(SEARCH_BOT_CAP);
		expect(catalog.slugs[0]).toBe("aaa");
		expect(catalog.text).toContain("soul: Hello");
		expect(catalog.text).toContain("more bots are not listed.");
		expect(catalog.slugs).not.toContain(
			`b${String(SEARCH_BOT_CAP).padStart(2, "0")}`,
		);
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
		expect(
			parseDescription(
				"---\ndescription: People Lior mentions.\nversion: 3\n---\n\nBody.\n",
			),
		).toBe("People Lior mentions.");
	});

	it("parses knowledge description fields, documents, and canonical format", () => {
		expect(parseDescriptionField(" People Lior mentions. ")).toBe(
			"People Lior mentions.",
		);
		expect(parseDescriptionField("")).toBeUndefined();
		expect(parseDescriptionField("x".repeat(241))).toBeUndefined();
		expect(parseDescriptionField("one\ntwo")).toBeUndefined();
		expect(
			parseKnowledge(
				"---\ndescription: People Lior mentions.\n---\n\nLior likes tea.\n",
			),
		).toEqual({
			description: "People Lior mentions.",
			version: 0,
			body: "\nLior likes tea.\n",
		});
		expect(
			parseKnowledge(
				"---\nversion: 4\ndescription: People Lior mentions.\n---\nbody",
			),
		).toEqual({
			description: "People Lior mentions.",
			version: 4,
			body: "body",
		});
		expect(
			parseKnowledge("---\ndescription: People.\nversion: 01\n---\n"),
		).toBeUndefined();
		expect(
			formatKnowledge({
				description: "People Lior mentions.",
				body: "Lior likes tea.\n",
				version: 1,
			}),
		).toBe(
			"---\ndescription: People Lior mentions.\nversion: 1\n---\nLior likes tea.\n",
		);
		expect(
			parseKnowledge(
				formatKnowledge({
					description: "People Lior mentions.",
					body: "Lior likes tea.\n",
					version: 2,
				}),
			),
		).toEqual({
			description: "People Lior mentions.",
			version: 2,
			body: "Lior likes tea.\n",
		});
		expect(parseCategoryField(" people ")).toBe("people");
		expect(parseCategoryField("x".repeat(64))).toBe("x".repeat(64));
		expect(parseCategoryField("x".repeat(65))).toBeUndefined();
		expect(parseCategoryField("one\ntwo")).toBeUndefined();
		expect(
			parseKnowledge(
				"---\ndescription: People Lior mentions.\ncategory: people\nversion: 3\n---\nLior likes tea.\n",
			),
		).toEqual({
			description: "People Lior mentions.",
			version: 3,
			category: "people",
			body: "Lior likes tea.\n",
		});
		expect(
			formatKnowledge({
				description: "People Lior mentions.",
				body: "Lior likes tea.\n",
				version: 1,
				category: "people",
			}),
		).toBe(
			"---\ndescription: People Lior mentions.\ncategory: people\nversion: 1\n---\nLior likes tea.\n",
		);
		expect(parseKnowledgeBody("Lior likes tea.\n")).toBe("Lior likes tea.\n");
		expect(parseKnowledgeBody("")).toBe("");
		expect(
			parseKnowledgeBody("---\ndescription: pasted\n---\nbody\n"),
		).toBeUndefined();
		expect(parseKnowledgeBody("---\n")).toBeUndefined();
		expect(
			parseKnowledge("---\ndescription: People.\nversion: 1\n---\n---\nbody\n"),
		).toBeUndefined();
		expect(KNOWLEDGE_FIELDS.map((field) => field.name)).toEqual([
			"description",
			"category",
			"version",
			"body",
		]);
		expect(
			parseKnowledgeWrite({
				description: "People Lior mentions.",
				body: "Lior likes tea.\n",
				version: 0,
				category: "people",
			}).ok,
		).toBe(true);
		expect(
			parseKnowledgeWrite({
				description: "x".repeat(241),
				body: "body",
				version: 0,
			}),
		).toEqual({
			ok: false,
			error: "description is required, one line, at most 240 characters.",
		});
		expect(
			parseKnowledgeWrite({
				description: "People.",
				body: "---\npasted\n",
				version: 0,
			}),
		).toEqual({
			ok: false,
			error: "body must not start with frontmatter (---).",
		});
	});

	it("parses MEMORY.md as version frontmatter and body", () => {
		expect(parseMemory("---\nversion: 0\n---\n")).toEqual({
			version: 0,
			body: "",
		});
		expect(parseMemory("---\nversion: 2\n---\nprefer emo voice\n")).toEqual({
			version: 2,
			body: "prefer emo voice\n",
		});
		expect(
			parseMemory("---\ndescription: no\nversion: 1\n---\nbody"),
		).toBeUndefined();
		expect(formatMemory({ version: 1, body: "x\n" })).toBe(
			"---\nversion: 1\n---\nx\n",
		);
		expect(parseMemoryWrite({ version: 0, body: "ok" }).ok).toBe(true);
		expect(parseMemoryWrite({ version: 0, body: "---\npasted\n" })).toEqual({
			ok: false,
			error: "body must not start with frontmatter (---).",
		});
		expect(
			parseMemoryWrite({ version: 0, body: "x".repeat(MEMORY_BODY_MAX + 1) }),
		).toEqual({
			ok: false,
			error: `body is at most ${MEMORY_BODY_MAX} bytes.`,
		});
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

	it("binds chat and session onto child log lines", () => {
		const lines: string[] = [];
		const stream = new Writable({
			write(chunk, _enc, callback) {
				lines.push(String(chunk));
				callback();
			},
		});
		setupLogger({ type: "console", level: "debug", stream, colors: false });
		getLogger()
			.child({ chat: "default:web:1", session: "conv-1" })
			.debug("chat input admitted", { requestId: "web:1", chars: 12 });
		expect(lines[0]).toMatch(/ DEBUG chat input admitted /);
		expect(lines[0]).toContain("chat=default:web:1");
		expect(lines[0]).toContain("session=conv-1");
		expect(lines[0]).toContain("requestId=web:1");
		setupLogger({ type: "silent" });
	});

	it("prints debug lines when LOG_LEVEL is debug", () => {
		expect(parseLogLevel("DEBUG")).toBe("debug");
		expect(parseLogLevel("bogus")).toBe("info");
		const lines: string[] = [];
		const stream = new Writable({
			write(chunk, _enc, callback) {
				lines.push(String(chunk));
				callback();
			},
		});
		setupLogger({ type: "console", level: "DEBUG", stream, colors: false });
		getLogger().debug("harvest started", { chat: "default:web:1" });
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(
			/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} DEBUG harvest started chat=default:web:1\n$/,
		);
		setupLogger({ type: "silent" });
	});

	it("treats first text or tool as the start of an answer", () => {
		const empty = {
			conversation: {} as ConversationView["conversation"],
			entries: [],
			docs: {},
		};
		expect(answerHasStarted(empty)).toBe(false);
		expect(
			answerHasStarted({
				...empty,
				docs: {
					"pi.live": {
						generation: {
							message: { content: [{ type: "text", text: "Hi" }] },
						},
					},
				},
			}),
		).toBe(true);
		expect(
			answerHasStarted({
				...empty,
				docs: {
					"pi.live": {
						generation: {
							message: { content: [{ type: "toolCall", id: "1", name: "x" }] },
						},
					},
				},
			}),
		).toBe(true);
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

	it("puts the bot name above the soul", () => {
		expect(soulWithName("Be concise.", "Pip")).toBe(
			"Your name is Pip.\n\nBe concise.",
		);
		expect(soulWithName("Be concise.", "  ")).toBe("Be concise.");
		expect(soulWithName("Be concise.")).toBe("Be concise.");
	});
});
