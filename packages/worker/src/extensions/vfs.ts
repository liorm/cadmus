import { createTwoFilesPatch } from "diff";
import type { BotFileStore, SkillScope } from "../store/family-interface.js";
import { formatSkillMarkdown, SLUG_REGEX } from "../store/sqlite-family.js";

export const CADMUS_VFS_ROOT = "/.cadmus";
export const SOUL_VFS_PATH = "/.cadmus/SOUL.md";
export const MEMORY_VFS_PATH = "/.cadmus/MEMORY.md";
export const SKILLS_VFS_DIR = "/.cadmus/skills";
export const BOT_SKILLS_VFS_DIR = "/.cadmus/skills/bot";
export const FAMILY_SKILLS_VFS_DIR = "/.cadmus/skills/family";

export function skillVfsPath(scope: SkillScope, slug: string): string {
	return `/.cadmus/skills/${scope}/${slug}/SKILL.md`;
}

export type ParsedVirtualPath =
	| { kind: "soul"; canonicalPath: typeof SOUL_VFS_PATH }
	| { kind: "memory"; canonicalPath: typeof MEMORY_VFS_PATH }
	| { kind: "skill"; scope: SkillScope; slug: string; canonicalPath: string }
	| { kind: "invalid"; rawPath: string; error: string };

/**
 * Classify a file tool or protocol path against the `/.cadmus/` virtual root.
 *
 * Returns `null` for non-virtual paths (which belong to the workspace `tools-env`).
 * Any path starting with `/.cadmus` is owned by Cadmus VFS and never leaks to disk.
 */
export function parseVirtualPath(rawPath: string): ParsedVirtualPath | null {
	const trimmed = rawPath.trim();
	const normalized = trimmed.replace(/\\/g, "/").replace(/\/+/g, "/");
	if (
		normalized !== CADMUS_VFS_ROOT &&
		!normalized.startsWith(`${CADMUS_VFS_ROOT}/`)
	) {
		return null;
	}

	const rest = normalized.slice(CADMUS_VFS_ROOT.length + 1);
	const lowerRest = rest.toLowerCase();

	if (lowerRest === "soul.md") {
		return { kind: "soul", canonicalPath: SOUL_VFS_PATH };
	}
	if (lowerRest === "memory.md") {
		return { kind: "memory", canonicalPath: MEMORY_VFS_PATH };
	}

	const skillMatch = /^skills\/(bot|family)\/([^/]+)\/skill\.md$/i.exec(rest);
	if (skillMatch?.[1] && skillMatch[2]) {
		const scope = skillMatch[1].toLowerCase() as SkillScope;
		const slug = skillMatch[2];
		if (!SLUG_REGEX.test(slug)) {
			return {
				kind: "invalid",
				rawPath,
				error: `Invalid skill slug '${slug}' in '${rawPath}'. Slugs must match /^[a-z0-9][a-z0-9-]{0,63}$/.`,
			};
		}
		return {
			kind: "skill",
			scope,
			slug,
			canonicalPath: skillVfsPath(scope, slug),
		};
	}

	return {
		kind: "invalid",
		rawPath,
		error: `Invalid Cadmus virtual path '${rawPath}'. Expected /.cadmus/SOUL.md, /.cadmus/MEMORY.md, /.cadmus/skills/bot/<slug>/SKILL.md, or /.cadmus/skills/family/<slug>/SKILL.md.`,
	};
}

export interface VirtualEdit {
	oldText: string;
	newText: string;
}

export interface VirtualEditResult {
	baseContent: string;
	newContent: string;
	finalContent: string;
	patch: string;
	firstChangedLine?: number;
}

/**
 * Apply one or more exact, non-overlapping replacements against the original file text.
 */
export function applyVirtualEdits(
	rawContent: string,
	edits: readonly VirtualEdit[],
	path: string,
): VirtualEditResult {
	if (!Array.isArray(edits) || edits.length === 0) {
		throw new Error(
			"Edit tool input is invalid. edits must contain at least one replacement.",
		);
	}

	const hasBom = rawContent.startsWith("\uFEFF");
	const bom = hasBom ? "\uFEFF" : "";
	const stripped = hasBom ? rawContent.slice(1) : rawContent;
	const usesCrlf = stripped.includes("\r\n");
	const baseContent = stripped.replace(/\r\n/g, "\n");

	const spans: Array<{ start: number; end: number; newText: string }> = [];

	for (const edit of edits) {
		const normalizedOld = edit.oldText.replace(/\r\n/g, "\n");
		const normalizedNew = edit.newText.replace(/\r\n/g, "\n");
		if (normalizedOld.length === 0) {
			throw new Error(`Could not edit ${path}: oldText cannot be empty.`);
		}
		const firstIdx = baseContent.indexOf(normalizedOld);
		if (firstIdx === -1) {
			throw new Error(
				`Could not find the exact text in ${path}. Make sure oldText matches the current file contents exactly.`,
			);
		}
		const secondIdx = baseContent.indexOf(normalizedOld, firstIdx + 1);
		if (secondIdx !== -1) {
			throw new Error(
				`Found multiple occurrences of oldText in ${path}. Include more surrounding context so oldText matches a single unique location.`,
			);
		}
		spans.push({
			start: firstIdx,
			end: firstIdx + normalizedOld.length,
			newText: normalizedNew,
		});
	}

	spans.sort((a, b) => a.start - b.start);
	for (let i = 1; i < spans.length; i++) {
		const prev = spans[i - 1];
		const curr = spans[i];
		if (prev && curr && prev.end > curr.start) {
			throw new Error(
				`Could not edit ${path}: edits contain overlapping oldText regions. Merge overlapping changes into a single edit.`,
			);
		}
	}

	let newContent = "";
	let cursor = 0;
	for (const span of spans) {
		newContent += baseContent.slice(cursor, span.start) + span.newText;
		cursor = span.end;
	}
	newContent += baseContent.slice(cursor);

	const firstSpan = spans[0];
	const firstChangedLine = firstSpan
		? baseContent.slice(0, firstSpan.start).split("\n").length
		: undefined;

	const restored = usesCrlf ? newContent.replace(/\n/g, "\r\n") : newContent;
	const finalContent = bom + restored;
	const patch = createTwoFilesPatch(
		path,
		path,
		baseContent,
		newContent,
		"",
		"",
		{
			context: 3,
		},
	);

	return {
		baseContent,
		newContent,
		finalContent,
		patch,
		...(firstChangedLine !== undefined ? { firstChangedLine } : {}),
	};
}

/**
 * Slice text by 1-indexed `offset` and optional `limit` line count, matching `read` tool semantics.
 */
export function sliceTextLines(
	content: string,
	offset?: number,
	limit?: number,
): { text: string; totalLines: number; truncated: boolean } {
	if (content.length === 0) {
		return { text: "", totalLines: 0, truncated: false };
	}
	const lines = content.split("\n");
	const totalLines = lines.length;
	const startIdx =
		offset !== undefined && Number.isFinite(offset)
			? Math.max(0, Math.trunc(offset) - 1)
			: 0;
	if (startIdx >= totalLines) {
		return { text: "", totalLines, truncated: false };
	}
	const endIdx =
		limit !== undefined && Number.isFinite(limit) && limit > 0
			? Math.min(totalLines, startIdx + Math.trunc(limit))
			: totalLines;
	return {
		text: lines.slice(startIdx, endIdx).join("\n"),
		totalLines,
		truncated: endIdx < totalLines,
	};
}

export interface VirtualFileEntry {
	path: string;
	content: string;
	bytes: number;
	description?: string;
	category?: string;
}

const MAX_LIST_DEPTH = 10;
const MAX_FIND_RESULTS = 200;
const DEFAULT_GREP_LIMIT = 50;
const MAX_GREP_LIMIT = 200;
const MAX_GREP_SNIPPET_CHARS = 300;
const textEncoder = new TextEncoder();

export function isVirtualScopePath(rawPath: string): boolean {
	const trimmed = rawPath.trim();
	const normalized = trimmed.replace(/\\/g, "/").replace(/\/+/g, "/");
	return (
		normalized === CADMUS_VFS_ROOT ||
		normalized.startsWith(`${CADMUS_VFS_ROOT}/`)
	);
}

export function normalizeVirtualScope(rawPath: string): string {
	const trimmed = rawPath.trim();
	if (!trimmed) return CADMUS_VFS_ROOT;
	const normalized = trimmed.replace(/\\/g, "/").replace(/\/+/g, "/");
	if (normalized.length > 1 && normalized.endsWith("/")) {
		return normalized.slice(0, -1);
	}
	return normalized;
}

function escapeRegExp(literal: string): string {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a glob pattern (`*`, `**`, `?`, `{a,b}`, `[abc]`) into a full-string RegExp.
 */
export function compileGlob(pattern: string): RegExp {
	const normalized = pattern.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
	let regex = "^";

	const compileSegment = (
		src: string,
		stopOnCommaOrBrace = false,
	): [string, number] => {
		let out = "";
		let idx = 0;
		while (idx < src.length) {
			const ch = src[idx] ?? "";
			if (stopOnCommaOrBrace && (ch === "," || ch === "}")) {
				return [out, idx];
			}
			if (ch === "*") {
				if (src[idx + 1] === "*") {
					if (src[idx + 2] === "/") {
						out += "(?:.+/)?";
						idx += 3;
					} else {
						out += ".*";
						idx += 2;
					}
				} else {
					out += "[^/]*";
					idx += 1;
				}
				continue;
			}
			if (ch === "?") {
				out += "[^/]";
				idx += 1;
				continue;
			}
			if (ch === "[") {
				const close = src.indexOf("]", idx + 1);
				if (close > idx + 1) {
					let body = src.slice(idx + 1, close);
					if (body.startsWith("!")) {
						body = `^${body.slice(1)}`;
					}
					out += `[${body}]`;
					idx = close + 1;
					continue;
				}
				out += "\\[";
				idx += 1;
				continue;
			}
			if (ch === "{") {
				const alts: string[] = [];
				let cursor = idx + 1;
				let closed = false;
				while (cursor < src.length) {
					const [part, consumed] = compileSegment(src.slice(cursor), true);
					alts.push(part);
					cursor += consumed;
					const delim = src[cursor];
					if (delim === ",") {
						cursor += 1;
						continue;
					}
					if (delim === "}") {
						cursor += 1;
						closed = true;
						break;
					}
					break;
				}
				if (closed && alts.length > 0) {
					out += `(?:${alts.join("|")})`;
					idx = cursor;
					continue;
				}
				out += "\\{";
				idx += 1;
				continue;
			}
			out += escapeRegExp(ch);
			idx += 1;
		}
		return [out, idx];
	};

	const [compiled] = compileSegment(normalized, false);
	regex += `${compiled}$`;
	return new RegExp(regex);
}

export function collectVirtualFiles(
	files: BotFileStore,
	botId: string,
	defaultSoul = "",
): VirtualFileEntry[] {
	const entries: VirtualFileEntry[] = [];
	const soulContent = files.getSoul(botId).trim() || defaultSoul;
	entries.push({
		path: SOUL_VFS_PATH,
		content: soulContent,
		bytes: textEncoder.encode(soulContent).byteLength,
	});
	const memContent = files.getMemory(botId).content;
	entries.push({
		path: MEMORY_VFS_PATH,
		content: memContent,
		bytes: textEncoder.encode(memContent).byteLength,
	});
	for (const skill of files.listSkills(botId)) {
		const content = formatSkillMarkdown(skill);
		entries.push({
			path: skillVfsPath("bot", skill.slug),
			content,
			bytes: textEncoder.encode(content).byteLength,
			description: skill.description,
			...(skill.category ? { category: skill.category } : {}),
		});
	}
	for (const skill of files.listFamilySkills()) {
		const content = formatSkillMarkdown(skill);
		entries.push({
			path: skillVfsPath("family", skill.slug),
			content,
			bytes: textEncoder.encode(content).byteLength,
			description: skill.description,
			...(skill.category ? { category: skill.category } : {}),
		});
	}
	entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return entries;
}

function resolveVirtualScopeTarget(
	entries: readonly VirtualFileEntry[],
	rawScope: string,
):
	| { kind: "file"; entry: VirtualFileEntry }
	| { kind: "dir"; dirPath: string; entries: VirtualFileEntry[] }
	| { kind: "missing"; error: string } {
	const scope = normalizeVirtualScope(rawScope);
	if (!isVirtualScopePath(scope)) {
		return {
			kind: "missing",
			error: `Path '${rawScope}' is outside Cadmus virtual root ${CADMUS_VFS_ROOT}.`,
		};
	}

	const lowerScope = scope.toLowerCase();
	const exactFile = entries.find((e) => e.path.toLowerCase() === lowerScope);
	if (exactFile) {
		return { kind: "file", entry: exactFile };
	}

	if (
		lowerScope === CADMUS_VFS_ROOT ||
		lowerScope === SKILLS_VFS_DIR ||
		lowerScope === BOT_SKILLS_VFS_DIR ||
		lowerScope === FAMILY_SKILLS_VFS_DIR
	) {
		const dirPath =
			lowerScope === CADMUS_VFS_ROOT
				? CADMUS_VFS_ROOT
				: lowerScope === SKILLS_VFS_DIR
					? SKILLS_VFS_DIR
					: lowerScope === BOT_SKILLS_VFS_DIR
						? BOT_SKILLS_VFS_DIR
						: FAMILY_SKILLS_VFS_DIR;
		const matching = entries.filter((e) => e.path.startsWith(`${dirPath}/`));
		return { kind: "dir", dirPath, entries: matching };
	}

	const skillDirMatch = /^\/\.cadmus\/skills\/(bot|family)\/([^/]+)$/i.exec(
		scope,
	);
	if (skillDirMatch?.[1] && skillDirMatch[2]) {
		const skillScope = skillDirMatch[1].toLowerCase();
		const candidateDir = `${SKILLS_VFS_DIR}/${skillScope}/${skillDirMatch[2]}`;
		const matching = entries.filter((e) =>
			e.path.startsWith(`${candidateDir}/`),
		);
		if (matching.length > 0) {
			return { kind: "dir", dirPath: candidateDir, entries: matching };
		}
	}

	return {
		kind: "missing",
		error: `Virtual path '${rawScope}' not found.`,
	};
}

export function listVirtualEntries(
	entries: readonly VirtualFileEntry[],
	scopePath: string = CADMUS_VFS_ROOT,
	options?: { depth?: number; details?: boolean },
): { ok: true; text: string } | { ok: false; error: string } {
	const resolved = resolveVirtualScopeTarget(entries, scopePath);
	if (resolved.kind === "missing") {
		return { ok: false, error: resolved.error };
	}
	const details = options?.details === true;
	if (resolved.kind === "file") {
		const f = resolved.entry;
		return {
			ok: true,
			text: details
				? `${f.path} [file, ${f.bytes} bytes${f.description ? `, ${f.description}` : ""}]`
				: f.path,
		};
	}

	const depth =
		options?.depth !== undefined && Number.isFinite(options.depth)
			? Math.min(MAX_LIST_DEPTH, Math.max(1, Math.trunc(options.depth)))
			: 1;
	const prefix = `${resolved.dirPath}/`;
	const dirs = new Set<string>();
	const rows = new Map<string, { isDir: boolean; entry?: VirtualFileEntry }>();

	if (resolved.dirPath === CADMUS_VFS_ROOT) {
		dirs.add("skills");
		rows.set("skills/", { isDir: true });
		if (depth >= 2) {
			dirs.add("skills/bot");
			rows.set("skills/bot/", { isDir: true });
			dirs.add("skills/family");
			rows.set("skills/family/", { isDir: true });
		}
	} else if (resolved.dirPath === SKILLS_VFS_DIR) {
		dirs.add("bot");
		rows.set("bot/", { isDir: true });
		dirs.add("family");
		rows.set("family/", { isDir: true });
	}

	for (const entry of resolved.entries) {
		const rel = entry.path.slice(prefix.length);
		const parts = rel.split("/");
		for (let i = 1; i < parts.length && i <= depth; i++) {
			const dirRel = parts.slice(0, i).join("/");
			if (!dirs.has(dirRel)) {
				dirs.add(dirRel);
				rows.set(`${dirRel}/`, { isDir: true });
			}
		}
		if (parts.length <= depth) {
			rows.set(rel, { isDir: false, entry });
		}
	}

	if (rows.size === 0) {
		return { ok: true, text: "(empty)" };
	}

	const lines = [...rows.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([label, meta]) => {
			if (!details) return label;
			if (meta.isDir) return `${label} [dir]`;
			const e = meta.entry;
			if (!e) return label;
			return `${label} [file, ${e.bytes} bytes${e.description ? `, ${e.description}` : ""}]`;
		});

	return { ok: true, text: lines.join("\n") };
}

export function matchGlobFilter(
	rawGlob: string,
	globRe: RegExp,
	absPath: string,
	relPath: string,
): boolean {
	const normalized = rawGlob.trim().replace(/\\/g, "/");
	if (normalized.startsWith("/")) {
		return globRe.test(absPath);
	}
	if (normalized.includes("/")) {
		return globRe.test(relPath) || globRe.test(absPath);
	}
	const lastSlash = absPath.lastIndexOf("/");
	const base = lastSlash >= 0 ? absPath.slice(lastSlash + 1) : absPath;
	return globRe.test(base) || globRe.test(relPath);
}

export function findVirtualFiles(
	entries: readonly VirtualFileEntry[],
	pattern: string,
	basePath: string = CADMUS_VFS_ROOT,
):
	| { ok: true; paths: string[]; truncated: boolean }
	| { ok: false; error: string } {
	const trimmedPattern = pattern.trim();
	if (!trimmedPattern) {
		return { ok: false, error: "Glob pattern cannot be empty." };
	}
	const resolved = resolveVirtualScopeTarget(entries, basePath);
	if (resolved.kind === "missing") {
		return { ok: false, error: resolved.error };
	}

	const candidates =
		resolved.kind === "file" ? [resolved.entry] : resolved.entries;
	const scopePrefix =
		resolved.kind === "dir" ? `${resolved.dirPath}/` : `${CADMUS_VFS_ROOT}/`;
	const globRe = compileGlob(trimmedPattern);
	const isAbsPattern = trimmedPattern.replace(/\\/g, "/").startsWith("/");

	const matched: string[] = [];
	let truncated = false;
	for (const entry of candidates) {
		const rel = entry.path.startsWith(scopePrefix)
			? entry.path.slice(scopePrefix.length)
			: entry.path;
		const hit = isAbsPattern
			? globRe.test(entry.path)
			: globRe.test(rel) || globRe.test(entry.path);
		if (!hit) continue;
		if (matched.length >= MAX_FIND_RESULTS) {
			truncated = true;
			break;
		}
		matched.push(entry.path);
	}

	return { ok: true, paths: matched, truncated };
}

export function grepVirtualFiles(
	entries: readonly VirtualFileEntry[],
	options: {
		pattern: string;
		path?: string;
		glob?: string;
		ignoreCase?: boolean;
		literal?: boolean;
		limit?: number;
	},
):
	| { ok: true; matches: string[]; truncated: boolean }
	| { ok: false; error: string } {
	if (!options.pattern) {
		return { ok: false, error: "Search pattern cannot be empty." };
	}
	const scopePath = options.path?.trim() || CADMUS_VFS_ROOT;
	const resolved = resolveVirtualScopeTarget(entries, scopePath);
	if (resolved.kind === "missing") {
		return { ok: false, error: resolved.error };
	}

	let regex: RegExp;
	try {
		const source = options.literal
			? escapeRegExp(options.pattern)
			: options.pattern;
		regex = new RegExp(source, options.ignoreCase ? "i" : "");
	} catch (error) {
		return {
			ok: false,
			error: `Invalid regex pattern: ${(error as Error).message}`,
		};
	}

	const globRe = options.glob?.trim() ? compileGlob(options.glob) : undefined;
	const scopePrefix =
		resolved.kind === "dir" ? `${resolved.dirPath}/` : `${CADMUS_VFS_ROOT}/`;
	const candidates =
		resolved.kind === "file" ? [resolved.entry] : resolved.entries;
	const limit =
		options.limit !== undefined && Number.isFinite(options.limit)
			? Math.min(MAX_GREP_LIMIT, Math.max(1, Math.trunc(options.limit)))
			: DEFAULT_GREP_LIMIT;

	const matches: string[] = [];
	let truncated = false;

	for (const entry of candidates) {
		if (globRe && options.glob) {
			const rel = entry.path.startsWith(scopePrefix)
				? entry.path.slice(scopePrefix.length)
				: entry.path;
			if (!matchGlobFilter(options.glob, globRe, entry.path, rel)) continue;
		}
		if (!entry.content) continue;
		const lines = entry.content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i] ?? "";
			if (!regex.test(line)) continue;
			if (matches.length >= limit) {
				truncated = true;
				return { ok: true, matches, truncated };
			}
			const snippet =
				line.length > MAX_GREP_SNIPPET_CHARS
					? `${line.slice(0, MAX_GREP_SNIPPET_CHARS - 3)}...`
					: line;
			matches.push(`${entry.path}:${i + 1}: ${snippet}`);
		}
	}

	return { ok: true, matches, truncated };
}
