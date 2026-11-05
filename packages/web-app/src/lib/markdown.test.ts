import { describe, expect, it } from "bun:test";
import { closeUnclosedFences, escapeHtml, safeHref } from "./markdown.ts";

describe("safeHref", () => {
	it("allows http, https, mailto, and rooted paths", () => {
		expect(safeHref("https://example.com")).toBe("https://example.com");
		expect(safeHref("http://example.com")).toBe("http://example.com");
		expect(safeHref("mailto:a@b.com")).toBe("mailto:a@b.com");
		expect(safeHref("/docs/soul")).toBe("/docs/soul");
	});

	it("drops javascript and protocol-relative URLs", () => {
		expect(safeHref("javascript:alert(1)")).toBeUndefined();
		expect(safeHref("//evil.example")).toBeUndefined();
		expect(safeHref("data:text/html,hi")).toBeUndefined();
	});
});

describe("closeUnclosedFences", () => {
	it("leaves balanced fences unchanged", () => {
		const src = "```ts\nconst x = 1;\n```";
		expect(closeUnclosedFences(src)).toBe(src);
	});

	it("closes a trailing open fence for streaming", () => {
		expect(closeUnclosedFences("```ts\nconst x = 1;")).toBe(
			"```ts\nconst x = 1;\n```\n",
		);
	});
});

describe("escapeHtml", () => {
	it("escapes tags", () => {
		expect(escapeHtml('<script>alert("xss")</script>')).toBe(
			"&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;",
		);
	});
});
