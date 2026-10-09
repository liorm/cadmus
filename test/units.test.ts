import { describe, expect, it } from "bun:test";
import { resolveProviderId } from "../src/harness/login.ts";
import { chatKey } from "../src/channels/telegram/chats.ts";
import { parseCommand } from "../src/channels/telegram/commands.ts";
import { chunkText } from "../src/channels/telegram/deliver.ts";
import { requestIdOf } from "../src/channels/telegram/poller.ts";
import { parseUserIds } from "../src/config.ts";
import { dayLine } from "../src/extensions/identity.ts";
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
		expect(chatKey({ chatId: -100 })).toBe("-100");
		expect(chatKey({ chatId: -100, threadId: 7 })).toBe("-100:7");
		expect(requestIdOf(-100, 42)).toBe("tg:-100:42");
	});

	it("chunks long replies under Telegram's limit", () => {
		const text = Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
		const chunks = chunkText(text);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(4000);
		expect(chunks.join("\n")).toBe(text);
		expect(chunkText("short")).toEqual(["short"]);
	});

	it("renders a daily date line", () => {
		expect(dayLine("Asia/Jerusalem", new Date("2026-10-09T22:30:00Z"))).toBe(
			"Today is 2026-10-10 (Saturday), time zone Asia/Jerusalem.",
		);
	});
});
