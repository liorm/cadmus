import { describe, expect, it } from "vitest";
import {
	applyVirtualEdits,
	compileGlob,
	findVirtualFiles,
	grepVirtualFiles,
	isVirtualScopePath,
	listVirtualEntries,
	MEMORY_VFS_PATH,
	parseVirtualPath,
	SOUL_VFS_PATH,
	skillVfsPath,
	sliceTextLines,
	type VirtualFileEntry,
} from "../../src/extensions/vfs.js";
import {
	formatSkillMarkdown,
	parseSkillMarkdown,
} from "../../src/store/sqlite-family.js";

describe("Cadmus VFS path routing (/.cadmus/*)", () => {
	it("routes canonical /.cadmus virtual paths", () => {
		expect(parseVirtualPath("/.cadmus/SOUL.md")).toEqual({
			kind: "soul",
			canonicalPath: SOUL_VFS_PATH,
		});
		expect(parseVirtualPath("/.cadmus/soul.md")).toEqual({
			kind: "soul",
			canonicalPath: SOUL_VFS_PATH,
		});
		expect(parseVirtualPath("/.cadmus/MEMORY.md")).toEqual({
			kind: "memory",
			canonicalPath: MEMORY_VFS_PATH,
		});
		expect(
			parseVirtualPath("/.cadmus/skills/bot/deploy-guide/SKILL.md"),
		).toEqual({
			kind: "skill",
			scope: "bot",
			slug: "deploy-guide",
			canonicalPath: skillVfsPath("bot", "deploy-guide"),
		});
		expect(
			parseVirtualPath("/.cadmus/skills/family/team-conventions/SKILL.md"),
		).toEqual({
			kind: "skill",
			scope: "family",
			slug: "team-conventions",
			canonicalPath: skillVfsPath("family", "team-conventions"),
		});
		expect(parseVirtualPath("/.cadmus/SKILLS/BOT/my-skill/skill.md")).toEqual({
			kind: "skill",
			scope: "bot",
			slug: "my-skill",
			canonicalPath: "/.cadmus/skills/bot/my-skill/SKILL.md",
		});
		expect(
			parseVirtualPath("/.cadmus/SKILLS/FAMILY/shared-guide/skill.md"),
		).toEqual({
			kind: "skill",
			scope: "family",
			slug: "shared-guide",
			canonicalPath: "/.cadmus/skills/family/shared-guide/SKILL.md",
		});
	});

	it("returns null for workspace paths so they never collide with /.cadmus/*", () => {
		expect(parseVirtualPath("MEMORY.md")).toBeNull();
		expect(parseVirtualPath("./MEMORY.md")).toBeNull();
		expect(parseVirtualPath("/workspace/MEMORY.md")).toBeNull();
		expect(parseVirtualPath("SOUL.md")).toBeNull();
		expect(parseVirtualPath("skills/bot/deploy/SKILL.md")).toBeNull();
		expect(parseVirtualPath("/workspace/skills/deploy/SKILL.md")).toBeNull();
		expect(parseVirtualPath("docs/notes.md")).toBeNull();
	});

	it("rejects malformed and legacy flat /.cadmus/* paths as invalid instead of falling through to workspace", () => {
		const cases = [
			"/.cadmus",
			"/.cadmus/",
			"/.cadmus/other.md",
			"/.cadmus/skills/flat.md",
			"/.cadmus/skills/legacy-slug/SKILL.md",
			"/.cadmus/skills/other/my-skill/SKILL.md",
			"/.cadmus/skills/bot/Bad_Slug/SKILL.md",
			"/.cadmus/skills/family/Bad_Slug/SKILL.md",
			"/.cadmus/skills/bot/foo/other.md",
			"/.cadmus/skills/bot/foo/sub/SKILL.md",
		];
		for (const p of cases) {
			const res = parseVirtualPath(p);
			expect(res?.kind, `expected invalid for ${p}`).toBe("invalid");
		}
	});
});

describe("applyVirtualEdits", () => {
	it("applies multiple non-overlapping exact edits and produces a patch", () => {
		const res = applyVirtualEdits(
			"line 1\nline 2\nline 3\n",
			[
				{ oldText: "line 1", newText: "LINE ONE" },
				{ oldText: "line 3", newText: "LINE THREE" },
			],
			MEMORY_VFS_PATH,
		);
		expect(res.finalContent).toBe("LINE ONE\nline 2\nLINE THREE\n");
		expect(res.firstChangedLine).toBe(1);
		expect(res.patch).toContain("-line 1");
		expect(res.patch).toContain("+LINE ONE");
	});

	it("rejects missing, ambiguous, or overlapping edits", () => {
		expect(() =>
			applyVirtualEdits("a\nb\n", [{ oldText: "missing", newText: "x" }], "f"),
		).toThrow(/Could not find/);
		expect(() =>
			applyVirtualEdits("dup\ndup\n", [{ oldText: "dup", newText: "x" }], "f"),
		).toThrow(/multiple occurrences/);
		expect(() =>
			applyVirtualEdits(
				"abcdef",
				[
					{ oldText: "abcd", newText: "1" },
					{ oldText: "cdef", newText: "2" },
				],
				"f",
			),
		).toThrow(/overlapping/);
	});
});

describe("formatSkillMarkdown / parseSkillMarkdown", () => {
	it("round-trips frontmatter with name, description, optional category, and body", () => {
		const md = formatSkillMarkdown({
			slug: "release-check",
			description: "Run release checklist before deploying",
			category: "ops",
			version: 2,
			body: "# Checklist\n- Run tests\n",
			updatedAt: 0,
		});
		expect(md).toBe(
			"---\nname: release-check\ndescription: Run release checklist before deploying\ncategory: ops\n---\n\n# Checklist\n- Run tests\n",
		);
		const parsed = parseSkillMarkdown(md);
		expect(parsed).toEqual({
			name: "release-check",
			description: "Run release checklist before deploying",
			category: "ops",
			version: undefined,
			body: "# Checklist\n- Run tests\n",
		});
	});

	it("parses frontmatter with empty body ending at EOF ---", () => {
		const parsed = parseSkillMarkdown(
			"---\nname: stub\ndescription: Empty body skill\n---",
		);
		expect(parsed.name).toBe("stub");
		expect(parsed.description).toBe("Empty body skill");
		expect(parsed.body).toBe("");
	});
});

describe("sliceTextLines", () => {
	it("slices 1-indexed offset and limit", () => {
		const text = "a\nb\nc\nd\ne";
		expect(sliceTextLines(text, 2, 2)).toEqual({
			text: "b\nc",
			totalLines: 5,
			truncated: true,
		});
		expect(sliceTextLines(text, 4, 10)).toEqual({
			text: "d\ne",
			totalLines: 5,
			truncated: false,
		});
	});
});

describe("VFS navigation & search (ls, find, grep)", () => {
	const entries: VirtualFileEntry[] = [
		{
			path: MEMORY_VFS_PATH,
			content: "- Prefers TypeScript\n- Deployment target: Cloudflare Workers",
			bytes: 60,
		},
		{
			path: SOUL_VFS_PATH,
			content: "You are a helpful assistant.",
			bytes: 28,
		},
		{
			path: skillVfsPath("bot", "deploy-guide"),
			content:
				"---\nname: deploy-guide\ndescription: How to deploy\ncategory: ops\n---\n\nRun wrangler deploy.",
			bytes: 88,
			description: "How to deploy",
			category: "ops",
		},
		{
			path: skillVfsPath("family", "sql-notes"),
			content:
				"---\nname: sql-notes\ndescription: SQLite tips\n---\n\nUse WAL mode and indexes.",
			bytes: 76,
			description: "SQLite tips",
		},
	];

	it("recognizes virtual scope paths", () => {
		expect(isVirtualScopePath("/.cadmus")).toBe(true);
		expect(isVirtualScopePath("/.cadmus/")).toBe(true);
		expect(isVirtualScopePath("/.cadmus/skills")).toBe(true);
		expect(isVirtualScopePath("/.cadmus/skills/bot")).toBe(true);
		expect(isVirtualScopePath("/.cadmus/skills/family")).toBe(true);
		expect(isVirtualScopePath("/.cadmus/skills/bot/deploy-guide")).toBe(true);
		expect(isVirtualScopePath("/workspace/src")).toBe(false);
		expect(isVirtualScopePath("MEMORY.md")).toBe(false);
	});

	it("compiles globs with *, **, ?, and brace alternations", () => {
		const skillsMd = compileGlob("/.cadmus/skills/**/*.md");
		expect(skillsMd.test("/.cadmus/skills/bot/deploy-guide/SKILL.md")).toBe(
			true,
		);
		expect(skillsMd.test("/.cadmus/skills/family/sql-notes/SKILL.md")).toBe(
			true,
		);
		expect(skillsMd.test("/.cadmus/MEMORY.md")).toBe(false);

		const brace = compileGlob("**/{MEMORY,SOUL}.md");
		expect(brace.test("/.cadmus/MEMORY.md")).toBe(true);
		expect(brace.test("/.cadmus/SOUL.md")).toBe(true);
		expect(brace.test("/.cadmus/skills/family/sql-notes/SKILL.md")).toBe(false);

		const singleSeg = compileGlob("*{MEMORY,SOUL}.md");
		expect(singleSeg.test("MEMORY.md")).toBe(true);
		expect(singleSeg.test("/.cadmus/MEMORY.md")).toBe(false);
	});

	it("lists virtual directories with depth and details", () => {
		const root = listVirtualEntries(entries, "/.cadmus");
		expect(root).toEqual({
			ok: true,
			text: "MEMORY.md\nSOUL.md\nskills/",
		});

		const skillsRoot = listVirtualEntries(entries, "/.cadmus/skills");
		expect(skillsRoot).toEqual({
			ok: true,
			text: "bot/\nfamily/",
		});

		const deep = listVirtualEntries(entries, "/.cadmus", {
			depth: 4,
			details: true,
		});
		expect(deep.ok).toBe(true);
		if (deep.ok) {
			expect(deep.text).toContain("MEMORY.md [file, 60 bytes]");
			expect(deep.text).toContain("skills/ [dir]");
			expect(deep.text).toContain("skills/bot/ [dir]");
			expect(deep.text).toContain("skills/family/ [dir]");
			expect(deep.text).toContain("skills/bot/deploy-guide/ [dir]");
			expect(deep.text).toContain(
				"skills/bot/deploy-guide/SKILL.md [file, 88 bytes, How to deploy]",
			);
			expect(deep.text).toContain(
				"skills/family/sql-notes/SKILL.md [file, 76 bytes, SQLite tips]",
			);
		}

		const missing = listVirtualEntries(entries, "/.cadmus/unknown");
		expect(missing.ok).toBe(false);
	});

	it("finds virtual files by glob with optional base path", () => {
		const skills = findVirtualFiles(entries, "/.cadmus/skills/**/*.md");
		expect(skills).toEqual({
			ok: true,
			paths: [
				"/.cadmus/skills/bot/deploy-guide/SKILL.md",
				"/.cadmus/skills/family/sql-notes/SKILL.md",
			],
			truncated: false,
		});

		const rel = findVirtualFiles(
			entries,
			"bot/deploy-*/*.md",
			"/.cadmus/skills",
		);
		expect(rel).toEqual({
			ok: true,
			paths: ["/.cadmus/skills/bot/deploy-guide/SKILL.md"],
			truncated: false,
		});
	});

	it("greps virtual files with regex, literal, ignoreCase, glob, and limit", () => {
		const res = grepVirtualFiles(entries, {
			pattern: "deploy",
			ignoreCase: true,
		});
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.matches).toEqual([
				"/.cadmus/MEMORY.md:2: - Deployment target: Cloudflare Workers",
				"/.cadmus/skills/bot/deploy-guide/SKILL.md:2: name: deploy-guide",
				"/.cadmus/skills/bot/deploy-guide/SKILL.md:3: description: How to deploy",
				"/.cadmus/skills/bot/deploy-guide/SKILL.md:7: Run wrangler deploy.",
			]);
		}

		const scoped = grepVirtualFiles(entries, {
			pattern: "deploy",
			path: "/.cadmus/skills",
			glob: "*sql*",
		});
		expect(scoped).toEqual({ ok: true, matches: [], truncated: false });

		const literal = grepVirtualFiles(entries, {
			pattern: "[invalid(",
			literal: true,
		});
		expect(literal).toEqual({ ok: true, matches: [], truncated: false });

		const badRegex = grepVirtualFiles(entries, { pattern: "[invalid(" });
		expect(badRegex.ok).toBe(false);

		const limited = grepVirtualFiles(entries, {
			pattern: "e",
			limit: 2,
		});
		expect(limited.ok).toBe(true);
		if (limited.ok) {
			expect(limited.matches).toHaveLength(2);
			expect(limited.truncated).toBe(true);
		}
	});
});
