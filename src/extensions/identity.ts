import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defineExtension, section } from "@earendil-works/pi-durable";

export const DEFAULT_SOUL = `You are a personal assistant that talks with your user through Telegram.
Be direct, warm and concise. Plain text renders best; keep formatting light.
You run on a durable runtime: your conversation survives restarts. If you were interrupted, say so plainly rather than guessing what happened.`;

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
	const date = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
	const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(now);
	return `Today is ${date} (${weekday}), time zone ${timeZone}.`;
}

/**
 * Identity sections, ordered stable → volatile (architecture §2.4): SOUL.md (persona), AGENTS.md (standing context),
 * then a date line that changes daily. Files live in the bot home and are read at render time; only changed sections are
 * re-sent as positional system entries, so editing a file takes effect on the next request.
 */
export function identityExtension(options: { home: string; timeZone: string; now?: () => Date }) {
	const now = options.now ?? (() => new Date());
	return defineExtension({
		name: "pi-bot.identity",
		sections: [
			section("soul", async () => (await readOptional(join(options.home, "SOUL.md"))) ?? DEFAULT_SOUL, { tag: false }),
			section("agents", () => readOptional(join(options.home, "AGENTS.md"))),
			section("date", () => dayLine(options.timeZone, now())),
		],
	});
}
