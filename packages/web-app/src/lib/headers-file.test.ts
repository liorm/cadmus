import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const root = new URL("..", new URL("../", import.meta.url)).pathname;
const read = (path: string) => readFileSync(`${root}${path}`, "utf8");
const built = existsSync(`${root}dist/index.html`);
/** CI that builds first sets this so a missing dist fails instead of skipping. */
const requireDist = process.env.CADMUS_REQUIRE_DIST === "1";

/**
 * CSP hash of every inline script: any <script ...> element without a src
 * attribute, whatever other attributes it has (type, nonce, crossorigin).
 */
export function inlineScriptHashes(html: string): string[] {
	return (
		[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
			// `src=` as its own attribute: `data-src=` and `xsrc=` do not make a script external.
			.filter((match) => !/(?:^|\s)src\s*=/i.test(match[1] ?? ""))
			.map(
				(match) =>
					`'sha256-${createHash("sha256")
						.update(match[2] ?? "")
						.digest("base64")}'`,
			)
	);
}

function headersFile(): string {
	return read("public/_headers");
}

function csp(): string {
	const line = headersFile()
		.split("\n")
		.find((l) => l.trim().startsWith("Content-Security-Policy:"));
	if (!line) throw new Error("no Content-Security-Policy line");
	return line.trim().slice("Content-Security-Policy:".length).trim();
}

function directive(name: string): string {
	const found = csp()
		.split(";")
		.map((d) => d.trim())
		.find((d) => d === name || d.startsWith(`${name} `));
	if (!found) throw new Error(`no ${name} directive`);
	return found;
}

describe("inlineScriptHashes", () => {
	test("hashes inline scripts with or without attributes and skips src scripts", () => {
		const html = `<script>a()</script><script type="module">b()</script>
			<script nonce="n" crossorigin>c()</script><script src="/x.js"></script>
			<script type="module" crossorigin src="/y.js"></script>`;
		const hashes = inlineScriptHashes(html);
		const h = (s: string) =>
			`'sha256-${createHash("sha256").update(s).digest("base64")}'`;
		expect(hashes).toEqual([h("a()"), h("b()"), h("c()")]);
	});

	test("an attribute that merely ends in src (data-src) does not make a script external", () => {
		const html = `<script data-src="/x.js">d()</script><script xsrc="/x.js">e()</script>
			<script data-a="b" SRC = "/y.js"></script><script\nsrc='/z.js'></script>`;
		const h = (s: string) =>
			`'sha256-${createHash("sha256").update(s).digest("base64")}'`;
		expect(inlineScriptHashes(html)).toEqual([h("d()"), h("e()")]);
	});
});

describe("public/_headers (static assets, not applied to Worker responses)", () => {
	test("script-src contains the hash of every inline script in index.html and no unsafe keywords", () => {
		const script = directive("script-src");
		const hashes = inlineScriptHashes(read("index.html"));
		expect(hashes.length).toBeGreaterThan(0);
		for (const hash of hashes) expect(script).toContain(hash);
		expect(script).not.toContain("unsafe-inline");
		expect(script).not.toContain("unsafe-eval");
	});

	test.skipIf(!built && !requireDist)(
		"the built page has no inline script the policy lacks (needs dist; CADMUS_REQUIRE_DIST=1 fails when it is missing)",
		() => {
			expect(built).toBe(true);
			for (const hash of inlineScriptHashes(read("dist/index.html"))) {
				expect(directive("script-src")).toContain(hash);
			}
		},
	);

	test("img-src is exactly 'self' data: https: (remote https images load from any host; http: is blocked)", () => {
		expect(directive("img-src")).toBe("img-src 'self' data: https:");
	});

	test("the other fetch directives stay narrow", () => {
		expect(directive("connect-src")).toBe("connect-src 'self'");
		expect(directive("form-action")).toBe("form-action 'self'");
		expect(directive("font-src")).toBe("font-src 'self'");
		expect(directive("style-src")).toBe("style-src 'self' 'unsafe-inline'");
		expect(directive("script-src")).toMatch(
			/^script-src 'self' 'sha256-[A-Za-z0-9+/=]+' https:\/\/static\.cloudflareinsights\.com$/,
		);
	});

	test("denies by default and sets each framing, plugin, base, sniffing and referrer rule", () => {
		expect(directive("default-src")).toBe("default-src 'none'");
		expect(directive("frame-ancestors")).toBe("frame-ancestors 'none'");
		expect(directive("object-src")).toBe("object-src 'none'");
		expect(directive("base-uri")).toBe("base-uri 'none'");
		expect(headersFile()).toContain("X-Content-Type-Options: nosniff");
		expect(headersFile()).toContain("X-Frame-Options: DENY");
		expect(headersFile()).toContain("Referrer-Policy: no-referrer");
	});
});
