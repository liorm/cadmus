import {
	mkdir,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { parseKnowledgeBody, parseVersion } from "./knowledge-parse.ts";

export const MEMORY_FILE = "MEMORY.md";
export const MEMORY_BODY_MAX = 8192;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export type MemoryDoc = { version: number; body: string };

export type MemoryRecord = {
	exists: boolean;
	version: number;
	body: string;
	created?: boolean;
};

export type LoadedMemory =
	| { status: "outside" }
	| { status: "missing"; path: string }
	| { status: "unreadable"; path: string }
	| { status: "ok"; path: string; doc: MemoryDoc; text: string };

function parseVersionField(value: string): number | undefined {
	const raw = value.trim();
	if (!/^(0|[1-9][0-9]*)$/.test(raw)) return undefined;
	const version = Number(raw);
	if (!Number.isSafeInteger(version)) return undefined;
	return version;
}

/** Frontmatter is version only. Extra keys or a `---` body are unreadable. */
export function parseMemory(text: string): MemoryDoc | undefined {
	const match = FRONTMATTER.exec(text);
	if (!match) return undefined;
	const raw = match[1] ?? "";
	if (raw === "") return undefined;
	let version: number | undefined;
	for (const line of raw.split(/\r?\n/)) {
		const kv = /^([a-z]+):[ \t]*(.*)$/.exec(line);
		if (!kv) return undefined;
		const key = kv[1] ?? "";
		if (key !== "version") return undefined;
		if (version !== undefined) return undefined;
		version = parseVersionField(kv[2] ?? "");
		if (version === undefined) return undefined;
	}
	if (version === undefined) return undefined;
	const body = parseKnowledgeBody(text.slice(match[0].length));
	if (body === undefined) return undefined;
	return { version, body };
}

export function formatMemory(doc: MemoryDoc): string {
	return `---\nversion: ${doc.version}\n---\n${doc.body}`;
}

export function parseMemoryWrite(
	args: Record<string, unknown>,
): { ok: true; version: number; body: string } | { ok: false; error: string } {
	const version = parseVersion(args.version);
	if (version === undefined)
		return { ok: false, error: "Version is not a whole number." };
	if (typeof args.body !== "string")
		return {
			ok: false,
			error:
				"Markdown body without frontmatter. Empty is allowed. Must not start with ---.",
		};
	if (parseKnowledgeBody(args.body) === undefined)
		return { ok: false, error: "body must not start with frontmatter (---)." };
	if (byteLength(args.body) > MEMORY_BODY_MAX)
		return {
			ok: false,
			error: `body is at most ${MEMORY_BODY_MAX} bytes.`,
		};
	return { ok: true, version, body: args.body };
}

function byteLength(text: string): number {
	return new TextEncoder().encode(text).length;
}

export async function loadMemory(cwd: string): Promise<LoadedMemory> {
	const resolved = await resolveMemoryPath(cwd);
	if (!resolved.ok) return { status: "outside" };
	const text = await readFile(resolved.path, "utf8").catch(() => undefined);
	if (text === undefined) return { status: "missing", path: resolved.path };
	const doc = parseMemory(text);
	if (!doc) return { status: "unreadable", path: resolved.path };
	return { status: "ok", path: resolved.path, doc, text };
}

export function memoryReadPayload(
	loaded: LoadedMemory,
): { ok: true; record: MemoryRecord } | { ok: false; error: string } {
	if (loaded.status === "outside")
		return {
			ok: false,
			error: "This conversation is not inside a bot folder.",
		};
	if (loaded.status === "missing")
		return { ok: true, record: { exists: false, version: 0, body: "" } };
	if (loaded.status === "unreadable")
		return {
			ok: false,
			error: `${MEMORY_FILE} — unreadable frontmatter. memory_update will not overwrite it.`,
		};
	return {
		ok: true,
		record: {
			exists: true,
			version: loaded.doc.version,
			body: loaded.doc.body,
		},
	};
}

export async function commitMemoryUpdate(
	cwd: string,
	args: Record<string, unknown>,
): Promise<{ ok: true; record: MemoryRecord } | { ok: false; error: string }> {
	const parsed = parseMemoryWrite(args);
	if (!parsed.ok) return parsed;
	const loaded = await loadMemory(cwd);
	if (loaded.status === "outside")
		return {
			ok: false,
			error: "This conversation is not inside a bot folder.",
		};
	if (loaded.status === "unreadable")
		return {
			ok: false,
			error: `${MEMORY_FILE} — unreadable frontmatter. Version does not match.`,
		};
	if (loaded.status === "missing") {
		if (parsed.version !== 0)
			return { ok: false, error: "Version does not match." };
	} else if (loaded.doc.version !== parsed.version) {
		return { ok: false, error: "Version does not match." };
	}
	const next: MemoryDoc = { version: parsed.version + 1, body: parsed.body };
	const intended = formatMemory(next);
	const created = loaded.status === "missing";
	if (loaded.status === "ok" && loaded.text === intended) {
		return {
			ok: true,
			record: {
				exists: true,
				version: next.version,
				body: next.body,
				created: false,
			},
		};
	}
	await writeMemoryFile(loaded.path, intended);
	return {
		ok: true,
		record: {
			exists: true,
			version: next.version,
			body: next.body,
			created,
		},
	};
}

async function writeMemoryFile(path: string, text: string): Promise<void> {
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

async function resolveMemoryPath(
	cwd: string,
): Promise<{ ok: true; path: string } | { ok: false }> {
	let rootReal: string;
	try {
		rootReal = await realpath(cwd);
	} catch {
		return { ok: false };
	}
	const path = join(cwd, MEMORY_FILE);
	const real = await realpath(path).catch(() => undefined);
	if (real) {
		const rel = relative(rootReal, real);
		if (rel.startsWith("..") || isAbsolute(rel)) return { ok: false };
		return { ok: true, path };
	}
	return { ok: true, path };
}

/** Body for the identity section. Empty or missing omits the section. */
export async function memorySection(cwd: string): Promise<string | undefined> {
	const loaded = await loadMemory(cwd);
	if (loaded.status !== "ok") return undefined;
	if (!loaded.doc.body.trim()) return undefined;
	return `version ${loaded.doc.version}\n${loaded.doc.body}`;
}
