import { Writable } from "node:stream";
import { describe, expect, it } from "bun:test";
import { resolveProviderId } from "../src/harness/login.ts";
import { chatKey } from "../src/channels/telegram/chats.ts";
import { parseCommand } from "../src/channels/telegram/commands.ts";
import { chunkText } from "../src/channels/telegram/deliver.ts";
import { requestIdOf } from "../src/channels/telegram/poller.ts";
import { parseUserIds } from "../src/config.ts";
import { dayLine } from "../src/extensions/identity.ts";
import { slugifyBotName } from "../src/channels/bot-slug.ts";
import { parseDescription, parseSlug } from "../src/extensions/knowledge.ts";
import { getLogger, setupLogger } from "../src/log.ts";
import { modelConfigFromEnv, parseModelRef } from "../src/harness/models.ts";

// Unit tests only for small pure helpers; behaviour is covered by test/flows/.
describe("pure helpers", () => {
	it("maps login aliases", () => {
		expect(resolveProviderId("grok")).toBe("xai");
		expect(resolveProviderId("XAI")).toBe("xai");
	});

	it("parses commands, including /cmd@Bot, and ignores other bots and unknown commands", () => {
		expect(parseCommand("/new")).toEqual({ name: "new", args: "" });
		expect(parseCommand("/new@pi_test_bot  carry on", "pi_test_bot")).toEqual({ name: "new", args: "carry on" });
		expect(parseCommand("/new@other_bot", "pi_test_bot")).toBeUndefined();
		expect(parseCommand("/frobnicate")).toBeUndefined();
		expect(parseCommand("hello /new")).toBeUndefined();
	});

	it("parses model refs whose id contains slashes", () => {
		expect(parseModelRef("openrouter/anthropic/some-model")).toEqual({ provider: "openrouter", modelId: "anthropic/some-model" });
		expect(() => parseModelRef("nope")).toThrow(/provider/);
		expect(() => modelConfigFromEnv({})).toThrow(/PI_MODEL is required/);
		expect(modelConfigFromEnv({ PI_MODEL: "faux/echo", PI_THINKING_LEVEL: "low" })).toEqual({
			main: { provider: "faux", modelId: "echo" },
			thinkingLevel: "low",
		});
	});

	it("parses the allowlist", () => {
		expect([...parseUserIds("1, 2 3")]).toEqual([1, 2, 3]);
		expect(parseUserIds("").size).toBe(0);
		expect(() => parseUserIds("abc")).toThrow();
	});

	it("builds keys", () => {
		expect(chatKey("default", { chatId: -100 })).toBe("default:tg:general:-100");
		expect(chatKey("default", { chatId: -100, threadId: 7 })).toBe("default:tg:general:-100:7");
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
		expect(parseDescription("---\ndescription: People Lior mentions.\n---\n\nBody.\n")).toBe("People Lior mentions.");
		expect(parseDescription(`---\ndescription: ${"x".repeat(240)}\n---\n`)).toBe("x".repeat(240));
		expect(parseDescription(`---\ndescription: ${"x".repeat(241)}\n---\n`)).toBeUndefined();
		expect(parseDescription("---\ndescription:\n---\n")).toBeUndefined();
		expect(parseDescription("---\ndescription: one\nkind: two\n---\n")).toBeUndefined();
		expect(parseDescription("no frontmatter")).toBeUndefined();
		expect(parseDescription("---\ndescription: line one\nline two\n---\n")).toBeUndefined();
	});

	it("chunks long replies under Telegram's limit", () => {
		const text = Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
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
		expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} INFO {2}started model=xai\/grok-4\.7 home="\/data\/bot home"\n$/);
		expect(lines[1]).toContain("ERROR shutdown failed error=boom");
		expect(lines[1]).toContain("Error: boom");
		setupLogger({ type: "silent" });
	});

	it("renders a daily date line", () => {
		expect(dayLine("Asia/Jerusalem", new Date("2026-10-09T22:30:00Z"))).toBe(
			"Today is 2026-10-10 (Saturday), time zone Asia/Jerusalem.",
		);
	});
});
