import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WEB_HTML_CSP } from "../../packages/worker/src/web-routes";

const repoRoot = resolve(__dirname, "../..");

function read(rel: string): string {
	return readFileSync(resolve(repoRoot, rel), "utf8");
}

function inlineScriptHashes(html: string): string[] {
	return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
		.filter((match) => !/(?:^|\s)src\s*=/i.test(match[1] ?? ""))
		.map(
			(match) =>
				`'sha256-${createHash("sha256")
					.update(match[2] ?? "")
					.digest("base64")}'`,
		);
}

function headersCsp(): string {
	const line = read("packages/web-app/public/_headers")
		.split("\n")
		.find((l) => l.trim().startsWith("Content-Security-Policy:"));
	if (!line) throw new Error("Missing Content-Security-Policy in _headers");
	return line.trim().slice("Content-Security-Policy:".length).trim();
}

describe("split web artifacts conformance (issue #107)", () => {
	it("keeps Worker HTML CSP in lockstep with public/_headers", () => {
		expect(WEB_HTML_CSP).toBe(headersCsp());
	});

	it("covers inline script hashes for both login-app and web-app in CSP", () => {
		const csp = headersCsp();
		for (const file of [
			"packages/login-app/index.html",
			"packages/web-app/index.html",
		]) {
			const hashes = inlineScriptHashes(read(file));
			expect(hashes.length, file).toBeGreaterThan(0);
			for (const hash of hashes) {
				expect(csp, `${file} ${hash}`).toContain(hash);
			}
		}
	});

	it("keeps @cadmus/login-app free of main-app dependencies", () => {
		const pkg = JSON.parse(read("packages/login-app/package.json")) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};
		const allDeps = {
			...pkg.dependencies,
			...pkg.devDependencies,
		};
		for (const forbidden of [
			"@cadmus/web-app",
			"@tanstack/react-router",
			"react-markdown",
			"remark-gfm",
			"highlight.js",
			"lucide-react",
			"@radix-ui/react-dialog",
			"@radix-ui/react-slot",
			"@radix-ui/react-switch",
			"@radix-ui/react-toggle-group",
		]) {
			expect(allDeps[forbidden], forbidden).toBeUndefined();
		}
	});

	const assembledLogin = resolve(repoRoot, "dist/web/login/index.html");
	const assembledApp = resolve(repoRoot, "dist/web/app/index.html");

	it.skipIf(!existsSync(assembledLogin) || !existsSync(assembledApp))(
		"keeps assembled login and app artifacts strictly isolated",
		() => {
			const loginHtml = read("dist/web/login/index.html");
			const appHtml = read("dist/web/app/index.html");
			expect(loginHtml).toContain("/login/assets/");
			expect(loginHtml).not.toContain("/app/assets/");
			expect(appHtml).toContain("/app/assets/");
			expect(appHtml).not.toContain("/login/assets/");
			for (const hash of inlineScriptHashes(loginHtml)) {
				expect(WEB_HTML_CSP).toContain(hash);
			}
			for (const hash of inlineScriptHashes(appHtml)) {
				expect(WEB_HTML_CSP).toContain(hash);
			}
		},
	);
});
