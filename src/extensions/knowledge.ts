import { readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

/** How many knowledge files a prompt lists before a `N more` line. */
export const KNOWLEDGE_INDEX_CAP = 80;

const SLUG: Record<"bot" | "knowledge", RegExp> = {
	/** `bots/<botId>`, 1–32 characters. */
	bot: /^[a-z0-9][a-z0-9-]{0,31}$/,
	/** `knowledge/<slug>.md`, 1–64 characters. */
	knowledge: /^[a-z0-9][a-z0-9-]{0,63}$/,
};

/** The slug when `value` matches `kind`, otherwise `undefined`. */
export function parseSlug(
	value: string,
	kind: "bot" | "knowledge",
): string | undefined {
	return SLUG[kind].test(value) ? value : undefined;
}

/**
 * The `description` of a knowledge file: a single frontmatter line, 1–240 characters.
 * Any other shape is unreadable.
 */
export function parseDescription(text: string): string | undefined {
	const match = /^---\r?\ndescription:[ \t]*([^\r\n]*)\r?\n---(?:\r?\n|$)/.exec(
		text,
	);
	if (!match) return undefined;
	const description = (match[1] ?? "").trim();
	if (!description || description.length > 240) return undefined;
	return description;
}

function inside(rootReal: string, candidate: string): boolean {
	const rel = relative(rootReal, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Discovery index for `bots/<botId>/knowledge`. Bodies stay out. Invalid files are omitted and named in a warning.
 * More than {@link KNOWLEDGE_INDEX_CAP} valid files keep the first ones (path order) and a `N more` line.
 */
export async function knowledgeIndex(
	botDirectory: string,
): Promise<string | undefined> {
	const dir = join(botDirectory, "knowledge");
	let names: string[];
	try {
		names = (await readdir(dir)).filter((name) => name.endsWith(".md")).sort();
	} catch {
		return undefined;
	}
	const rootReal = await realpath(botDirectory);
	const valid: string[] = [];
	const warnings: string[] = [];
	for (const name of names) {
		const slug = name.slice(0, -".md".length);
		const path = join(dir, name);
		const real = await realpath(path).catch(() => undefined);
		const text =
			real && inside(rootReal, real)
				? await readFile(path, "utf8").catch(() => undefined)
				: undefined;
		const description = text === undefined ? undefined : parseDescription(text);
		if (!parseSlug(slug, "knowledge") || !description)
			warnings.push(`knowledge/${name} — unreadable frontmatter`);
		else valid.push(`knowledge/${name} — ${description}`);
	}
	if (valid.length === 0 && warnings.length === 0) return undefined;
	const shown = valid.slice(0, KNOWLEDGE_INDEX_CAP);
	const lines = [...shown];
	if (valid.length > KNOWLEDGE_INDEX_CAP)
		lines.push(`${valid.length - KNOWLEDGE_INDEX_CAP} more`);
	lines.push(...warnings);
	return lines.join("\n");
}
