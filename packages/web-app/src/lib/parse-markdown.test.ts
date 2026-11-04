import { describe, expect, it } from "bun:test";
import { parseMarkdown } from "./parse-markdown.ts";

describe("parseMarkdown", () => {
	it("parses headings, lists, emphasis, code, links, and quotes", () => {
		const blocks = parseMarkdown(
			[
				"# Title",
				"",
				"A **bold** and *italic* and `code` and [link](https://example.com).",
				"",
				"- one",
				"- two",
				"",
				"> quoted",
				"",
				"```js",
				"const x = 1;",
				"```",
			].join("\n"),
		);
		expect(blocks[0]).toMatchObject({ type: "heading", level: 1 });
		expect(blocks[1]?.type).toBe("paragraph");
		expect(blocks[2]).toMatchObject({ type: "list", ordered: false });
		expect(blocks[3]?.type).toBe("blockquote");
		expect(blocks[4]).toMatchObject({
			type: "code",
			lang: "js",
			text: "const x = 1;",
		});
	});

	it("keeps HTML as text instead of injecting it", () => {
		const blocks = parseMarkdown('<script>alert("xss")</script>');
		expect(blocks).toHaveLength(1);
		const para = blocks[0];
		expect(para?.type).toBe("paragraph");
		if (para?.type === "paragraph") {
			expect(para.children).toEqual([
				{ type: "text", text: '<script>alert("xss")</script>' },
			]);
		}
	});

	it("drops javascript: links", () => {
		const blocks = parseMarkdown("[x](javascript:alert(1))");
		const para = blocks[0];
		expect(para?.type).toBe("paragraph");
		if (para?.type === "paragraph") {
			expect(para.children.some((node) => node.type === "link")).toBe(false);
		}
	});
});
