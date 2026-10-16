import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
	defineExtension,
	type PromptInput,
	section,
} from "@earendil-works/pi-durable";
import { BotsDoc } from "../channels/bots.ts";
import { DEFAULT_SOUL, SYSTEM_PROMPT } from "./default-soul.ts";
import { knowledgeIndex } from "./knowledge.ts";
import { memorySection } from "./memory.ts";
import { botIdFromCwd } from "./self-tools/host.ts";

export { DEFAULT_SOUL };

async function readOptional(path: string): Promise<string | undefined> {
	try {
		const text = (await readFile(path, "utf8")).trim();
		return text || undefined;
	} catch {
		return undefined;
	}
}

/** `YYYY-MM-DD (Weekday)` in `timeZone`: changes once a day, so it does not defeat the prompt cache. */
export function dayLine(timeZone: string, now = new Date()): string {
	const date = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(now);
	const weekday = new Intl.DateTimeFormat("en-US", {
		timeZone,
		weekday: "long",
	}).format(now);
	return `Today is ${date} (${weekday}), time zone ${timeZone}.`;
}

/** Stored display name as a line above the persona. Empty or missing name leaves the soul as-is. */
export function soulWithName(soul: string, name?: string): string {
	const label = name?.trim();
	if (!label) return soul;
	return `Your name is ${label}.\n\n${soul}`;
}

async function botName(
	home: string,
	input: PromptInput,
	context: Context,
): Promise<string | undefined> {
	const id = botIdFromCwd(home, input.agent.cwd);
	if (!id) return undefined;
	const bots = await input.read.snapshot(BotsDoc, context);
	return bots?.items.find((bot) => bot.id === id)?.name;
}

/**
 * Identity sections, stable → volatile: `SOUL.md` (with the bot's name), system, knowledge index, MEMORY.md body, then a daily date.
 * Files are read from the conversation's agent cwd (`bots/<botId>`) at render time.
 */
export function identityExtension(options: {
	home: string;
	timeZone: string;
	now?: () => Date;
}) {
	const now = options.now ?? (() => new Date());
	return defineExtension({
		name: "pi-bot.identity",
		sections: [
			section(
				"soul",
				async (input, context) =>
					soulWithName(
						(input.agent.cwd
							? await readOptional(join(input.agent.cwd, "SOUL.md"))
							: undefined) ?? DEFAULT_SOUL,
						await botName(options.home, input, context),
					),
				{ tag: false },
			),
			section("system", (_input) => SYSTEM_PROMPT),
			section("knowledge", (input) =>
				input.agent.cwd ? knowledgeIndex(input.agent.cwd) : undefined,
			),
			section("memory", (input) =>
				input.agent.cwd ? memorySection(input.agent.cwd) : undefined,
			),
			section("date", () => dayLine(options.timeZone, now())),
		],
	});
}
