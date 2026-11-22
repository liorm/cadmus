import { describe, expect, it } from "vitest";
import {
	applyVirtualEdits,
	MEMORY_VFS_PATH,
	parseVirtualPath,
	SOUL_VFS_PATH,
	skillVfsPath,
	sliceTextLines,
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
		expect(parseVirtualPath("/.cadmus/skills/deploy-guide/SKILL.md")).toEqual({
			kind: "skill",
			slug: "deploy-guide",
			canonicalPath: skillVfsPath("deploy-guide"),
		});
		expect(parseVirtualPath("/.cadmus/SKILLS/my-skill/skill.md")).toEqual({
			kind: "skill",
			slug: "my-skill",
			canonicalPath: "/.cadmus/skills/my-skill/SKILL.md",
		});
	});

	it("returns null for workspace paths so they never collide with /.cadmus/*", () => {
		expect(parseVirtualPath("MEMORY.md")).toBeNull();
		expect(parseVirtualPath("./MEMORY.md")).toBeNull();
		expect(parseVirtualPath("/workspace/MEMORY.md")).toBeNull();
		expect(parseVirtualPath("SOUL.md")).toBeNull();
		expect(parseVirtualPath("skills/deploy/SKILL.md")).toBeNull();
		expect(parseVirtualPath("/workspace/skills/deploy/SKILL.md")).toBeNull();
		expect(parseVirtualPath("docs/notes.md")).toBeNull();
	});

	it("rejects malformed /.cadmus/* paths as invalid instead of falling through to workspace", () => {
		const cases = [
			"/.cadmus",
			"/.cadmus/",
			"/.cadmus/other.md",
			"/.cadmus/skills/flat.md",
			"/.cadmus/skills/Bad_Slug/SKILL.md",
			"/.cadmus/skills/foo/other.md",
			"/.cadmus/skills/foo/sub/SKILL.md",
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
