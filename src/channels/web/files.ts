import {
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { parseDescription, parseSlug } from "../../extensions/knowledge.ts";
import { botDir } from "../bots.ts";

export type ListedFile =
	| { path: "SOUL.md" }
	| { path: string; description: string | null; valid: boolean };

const ROOTS = new Set(["SOUL.md"]);

export async function listBotFiles(
	home: string,
	botId: string,
): Promise<ListedFile[] | undefined> {
	const root = botDir(home, botId);
	if (!(await exists(root))) return undefined;
	const files: ListedFile[] = [{ path: "SOUL.md" }];
	let names: string[] = [];
	try {
		names = (await readdir(join(root, "knowledge")))
			.filter((name) => name.endsWith(".md"))
			.sort();
	} catch {
		names = [];
	}
	for (const name of names) {
		const slug = name.slice(0, -".md".length);
		const text = await readFile(join(root, "knowledge", name), "utf8").catch(
			() => undefined,
		);
		const description = text === undefined ? undefined : parseDescription(text);
		const valid = Boolean(parseSlug(slug, "knowledge") && description);
		files.push({
			path: `knowledge/${name}`,
			description: description ?? null,
			valid,
		});
	}
	return files;
}

export async function readBotFile(
	home: string,
	botId: string,
	rel: string,
): Promise<
	{ ok: true; text: string } | { ok: false; status: 400 | 404; error: string }
> {
	const full = await resolveBotFile(home, botId, rel);
	if (!full.ok) return full;
	try {
		return { ok: true, text: await readFile(full.path, "utf8") };
	} catch {
		return { ok: false, status: 404, error: "No such file." };
	}
}

/**
 * Write one bot file. Knowledge files need a legal slug and a one-line description.
 * A failed check leaves the file as it was.
 */
export async function writeBotFile(
	home: string,
	botId: string,
	rel: string,
	text: string,
): Promise<{ ok: true } | { ok: false; status: 400 | 422; error: string }> {
	const problem = knowledgeProblem(rel, text);
	if (problem) return { ok: false, status: 422, error: problem };
	const full = await resolveBotFile(home, botId, rel);
	if (!full.ok) return full;
	const tmp = `${full.path}.${process.pid}.tmp`;
	try {
		await mkdir(join(full.path, ".."), { recursive: true });
		await writeFile(tmp, text);
		await rename(tmp, full.path);
	} catch (error) {
		await rm(tmp, { force: true });
		throw error;
	}
	return { ok: true };
}

function knowledgeProblem(rel: string, text: string): string | undefined {
	if (!rel.startsWith("knowledge/")) return undefined;
	const slug = rel.slice("knowledge/".length, -".md".length);
	if (!parseSlug(slug, "knowledge"))
		return "The file name is not a legal slug.";
	const description = parseDescription(text);
	if (description) return undefined;
	const line = /^---\r?\ndescription:[ \t]*([^\r\n]*)/m.exec(text);
	const length = line?.[1]?.trim().length ?? 0;
	if (length > 240)
		return `description is ${length} characters — max 240, one line. The file was not changed.`;
	return "description is required, one line, at most 240 characters. The file was not changed.";
}

async function resolveBotFile(
	home: string,
	botId: string,
	rel: string,
): Promise<
	{ ok: true; path: string } | { ok: false; status: 400; error: string }
> {
	if (!legalRelative(rel))
		return { ok: false, status: 400, error: "Path is outside the bot folder." };
	const root = botDir(home, botId);
	const full = join(root, rel);
	if (!(await inside(root, full)))
		return { ok: false, status: 400, error: "Path is outside the bot folder." };
	return { ok: true, path: full };
}

function legalRelative(rel: string): boolean {
	if (
		!rel ||
		rel.includes("\0") ||
		rel.startsWith("/") ||
		rel.includes("\\") ||
		rel.split("/").includes("..")
	)
		return false;
	if (ROOTS.has(rel)) return true;
	return /^knowledge\/[a-z0-9][a-z0-9-]{0,63}\.md$/.test(rel);
}

async function inside(root: string, full: string): Promise<boolean> {
	let rootReal: string;
	try {
		rootReal = await realpath(root);
	} catch {
		return false;
	}
	try {
		const real = await realpath(full);
		const rel = relative(rootReal, real);
		return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
	} catch {
		try {
			const parent = await realpath(join(full, ".."));
			const rel = relative(rootReal, parent);
			return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
		} catch {
			return false;
		}
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await realpath(path);
		return true;
	} catch {
		return false;
	}
}
