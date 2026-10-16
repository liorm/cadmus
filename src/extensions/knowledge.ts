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

/** How many knowledge files a prompt lists before a `N more` line. */
export const KNOWLEDGE_INDEX_CAP = 80;

export {
	applyKnowledgeWrite,
	draftFromRecord,
	emptyKnowledgeDraft,
	formatKnowledge,
	KNOWLEDGE_BODY_FIELD,
	KNOWLEDGE_FIELDS,
	KNOWLEDGE_LINE_FIELDS,
	KNOWLEDGE_VERSION_FIELD,
	type KnowledgeDoc,
	type KnowledgeDraft,
	type KnowledgeField,
	type KnowledgeRecord,
	knowledgeIndexLine,
	knowledgeParseError,
	knowledgeReadRecord,
	knowledgeWriteArgs,
	knowledgeWriteRecord,
	parseCategoryField,
	parseDescription,
	parseDescriptionField,
	parseKnowledge,
	parseKnowledgeBody,
	parseKnowledgeWrite,
	parseSlug,
	parseVersion,
} from "./knowledge-parse.ts";

import {
	applyKnowledgeWrite,
	formatKnowledge,
	type KnowledgeDoc,
	type KnowledgeRecord,
	knowledgeIndexLine,
	knowledgeReadRecord,
	knowledgeWriteRecord,
	parseKnowledge,
	parseKnowledgeWrite,
	parseSlug,
} from "./knowledge-parse.ts";

export type LoadedKnowledge =
	| { status: "outside" }
	| { status: "missing"; path: string }
	| { status: "unreadable"; path: string }
	| { status: "ok"; path: string; doc: KnowledgeDoc; text: string };

/** Resolve `knowledge/<slug>.md` under the bot folder. */
export async function loadKnowledge(
	cwd: string,
	slug: string,
): Promise<LoadedKnowledge> {
	const resolved = await resolveKnowledgePath(cwd, slug);
	if (!resolved.ok) return { status: "outside" };
	const text = await readFile(resolved.path, "utf8").catch(() => undefined);
	if (text === undefined) return { status: "missing", path: resolved.path };
	const doc = parseKnowledge(text);
	if (!doc) return { status: "unreadable", path: resolved.path };
	return { status: "ok", path: resolved.path, doc, text };
}

/**
 * Create or replace one knowledge entry. Same write the knowledge_update tool
 * and the HTTP knowledge API use. Frontmatter is composed here.
 */
export async function commitKnowledgeUpdate(
	cwd: string,
	args: Record<string, unknown>,
): Promise<
	{ ok: true; record: KnowledgeRecord } | { ok: false; error: string }
> {
	const slug =
		typeof args.slug === "string"
			? parseSlug(args.slug, "knowledge")
			: undefined;
	if (!slug) return { ok: false, error: "The name is not a legal slug." };
	const parsed = parseKnowledgeWrite(args);
	if (!parsed.ok) return parsed;
	const loaded = await loadKnowledge(cwd, slug);
	if (loaded.status === "outside")
		return { ok: false, error: "The name is not a legal slug." };
	const existing = loaded.status === "ok" ? loaded.doc : undefined;
	const next = applyKnowledgeWrite(existing, parsed.value);
	const intended = formatKnowledge(next);
	const created = loaded.status === "missing";
	const record = knowledgeWriteRecord(slug, next, created);
	if (loaded.status === "ok" && loaded.text === intended) {
		record.created = false;
		return { ok: true, record };
	}
	if (loaded.status === "unreadable")
		return {
			ok: false,
			error: `knowledge/${slug}.md — unreadable frontmatter. Version does not match.`,
		};
	if (loaded.status === "missing") {
		if (parsed.value.version !== 0)
			return { ok: false, error: "Version does not match." };
	} else if (loaded.doc.version !== parsed.value.version) {
		return { ok: false, error: "Version does not match." };
	}
	await writeKnowledgeFile(loaded.path, intended);
	return { ok: true, record };
}

export function knowledgeReadPayload(
	slug: string,
	loaded: LoadedKnowledge,
):
	| {
			ok: true;
			record: KnowledgeRecord | { slug: string; exists: false; version: 0 };
	  }
	| { ok: false; error: string } {
	if (loaded.status === "outside")
		return { ok: false, error: "The name is not a legal slug." };
	if (loaded.status === "missing")
		return { ok: true, record: { slug, exists: false, version: 0 } };
	if (loaded.status === "unreadable")
		return {
			ok: false,
			error: `knowledge/${slug}.md — unreadable frontmatter. knowledge_update will not overwrite it; knowledge_delete removes it.`,
		};
	return { ok: true, record: knowledgeReadRecord(slug, loaded.doc) };
}

/** Atomic write of a knowledge entry. Caller already confined the path. */
async function writeKnowledgeFile(path: string, text: string): Promise<void> {
	const tmp = `${path}.${process.pid}.tmp`;
	try {
		await mkdir(join(path, ".."), { recursive: true });
		await writeFile(tmp, text);
		await rename(tmp, path);
	} catch (error) {
		await rm(tmp, { force: true });
		throw error;
	}
}

export async function deleteKnowledge(
	cwd: string,
	slug: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const resolved = await resolveKnowledgePath(cwd, slug);
	if (!resolved.ok)
		return { ok: false, error: "The name is not a legal slug." };
	await rm(resolved.path, { force: true });
	return { ok: true };
}

async function resolveKnowledgePath(
	cwd: string,
	slug: string,
): Promise<{ ok: true; path: string } | { ok: false }> {
	let rootReal: string;
	try {
		rootReal = await realpath(cwd);
	} catch {
		return { ok: false };
	}
	const path = join(cwd, "knowledge", `${slug}.md`);
	const real = await realpath(path).catch(() => undefined);
	if (real) return inside(rootReal, real) ? { ok: true, path } : { ok: false };
	const parent = join(cwd, "knowledge");
	const parentReal = await realpath(parent).catch(() => undefined);
	if (parentReal)
		return inside(rootReal, parentReal) ? { ok: true, path } : { ok: false };
	return { ok: true, path };
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
		const doc = text === undefined ? undefined : parseKnowledge(text);
		if (!parseSlug(slug, "knowledge") || !doc)
			warnings.push(`knowledge/${name} — unreadable frontmatter`);
		else valid.push(knowledgeIndexLine(name, doc));
	}
	if (valid.length === 0 && warnings.length === 0) return undefined;
	const shown = valid.slice(0, KNOWLEDGE_INDEX_CAP);
	const lines = [...shown];
	if (valid.length > KNOWLEDGE_INDEX_CAP)
		lines.push(`${valid.length - KNOWLEDGE_INDEX_CAP} more`);
	lines.push(...warnings);
	return lines.join("\n");
}
