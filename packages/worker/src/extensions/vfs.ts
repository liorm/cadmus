import { createTwoFilesPatch } from "diff";
import { SLUG_REGEX } from "../store/sqlite-family.js";

export const CADMUS_VFS_ROOT = "/.cadmus";
export const SOUL_VFS_PATH = "/.cadmus/SOUL.md";
export const MEMORY_VFS_PATH = "/.cadmus/MEMORY.md";

export function skillVfsPath(slug: string): string {
	return `/.cadmus/skills/${slug}/SKILL.md`;
}

export type ParsedVirtualPath =
	| { kind: "soul"; canonicalPath: typeof SOUL_VFS_PATH }
	| { kind: "memory"; canonicalPath: typeof MEMORY_VFS_PATH }
	| { kind: "skill"; slug: string; canonicalPath: string }
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

	const skillMatch = /^skills\/([^/]+)\/skill\.md$/i.exec(rest);
	if (skillMatch?.[1]) {
		const slug = skillMatch[1];
		if (!SLUG_REGEX.test(slug)) {
			return {
				kind: "invalid",
				rawPath,
				error: `Invalid skill slug '${slug}' in '${rawPath}'. Slugs must match /^[a-z0-9][a-z0-9-]{0,63}$/.`,
			};
		}
		return {
			kind: "skill",
			slug,
			canonicalPath: skillVfsPath(slug),
		};
	}

	return {
		kind: "invalid",
		rawPath,
		error: `Invalid Cadmus virtual path '${rawPath}'. Expected /.cadmus/SOUL.md, /.cadmus/MEMORY.md, or /.cadmus/skills/<slug>/SKILL.md.`,
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
