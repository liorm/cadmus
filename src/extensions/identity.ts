import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { DEFAULT_SOUL } from "./default-soul.ts";
import { knowledgeIndex } from "./knowledge.ts";

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

/**
 * Identity sections, stable → volatile: `SOUL.md`, `SYSTEM.md`, the knowledge description index, then a daily date.
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
				async (input) =>
					(input.agent.cwd
						? await readOptional(join(input.agent.cwd, "SOUL.md"))
						: undefined) ?? DEFAULT_SOUL,
				{ tag: false },
			),
			section("system", (input) =>
				input.agent.cwd
					? readOptional(join(input.agent.cwd, "SYSTEM.md"))
					: undefined,
			),
			section("knowledge", (input) =>
				input.agent.cwd ? knowledgeIndex(input.agent.cwd) : undefined,
			),
			section("date", () => dayLine(options.timeZone, now())),
		],
	});
}
