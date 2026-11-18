import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	devLoginHelp,
	devLoginProblems,
	upsertDevLogin,
} from "../../scripts/dev-login.ts";

const valid = [
	"CADMUS_DEV_PASSWORD_LOGIN=1",
	"CADMUS_DEV_PASSWORD_HASH=pbkdf2-sha256$1000$BwcHBwcHBwcHBwcHBwcHBw$MLMr4QjaXgE1WBPr41dCQ-PdWaQjvF56G3iiWCe2kIU",
	"CADMUS_BOOTSTRAP_SUPER_ADMIN_EMAIL=boss@example.com",
	"CADMUS_DEPLOY_ENV=development",
].join("\n");

describe("dev login preflight", () => {
	test("a missing file points at dev:setup", () => {
		expect(devLoginProblems(null).join("\n")).toContain(".dev.vars");
		expect(devLoginHelp()).toContain("bun run dev:setup");
	});

	test("rejects a half-written file and a production deploy env", () => {
		expect(devLoginProblems("CADMUS_DEV_PASSWORD_LOGIN=1")).toHaveLength(3);
		expect(
			devLoginProblems(valid.replace("development", "production")),
		).toEqual([
			"CADMUS_DEPLOY_ENV must be development in .dev.vars (production refuses dev login)",
		]);
	});

	test("accepts a complete file and keeps unrelated keys", () => {
		expect(devLoginProblems(valid)).toEqual([]);
		const next = upsertDevLogin(`OTHER=1\n${valid}`, {
			CADMUS_DEV_PASSWORD_LOGIN: "1",
			CADMUS_DEV_PASSWORD_HASH: "pbkdf2-sha256$1$AA$BBBBBBBBBBBBBBBBBBBBBB",
			CADMUS_BOOTSTRAP_SUPER_ADMIN_EMAIL: "a@b.co",
			CADMUS_DEPLOY_ENV: "development",
		});
		expect(next).toContain("OTHER=1");
		expect(next.match(/CADMUS_DEV_PASSWORD_LOGIN/g)).toHaveLength(1);
		expect(devLoginProblems(next)).toEqual([]);
	});

	test("bun run dev goes through the preflight", () => {
		const pkg = JSON.parse(
			readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
		) as { scripts: { dev: string; "dev:setup": string } };
		expect(pkg.scripts.dev).toBe("bun scripts/dev.ts");
		expect(pkg.scripts["dev:setup"]).toBe("bun scripts/setup-dev.ts");
	});
});
