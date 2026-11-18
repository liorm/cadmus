/**
 * Writes the repo-root `.dev.vars` keys that local dev-password login needs.
 * Usage: bun scripts/setup-dev.ts [--email you@example.com] [--password secret] [--force]
 * With no flags in a terminal, it asks. It never prints the hash.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { hashDevPassword } from "../packages/worker/src/auth/dev-password.ts";
import {
	DEV_VARS_FILE,
	devLoginProblems,
	upsertDevLogin,
} from "./dev-login.ts";

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	if (index === -1) return undefined;
	return process.argv[index + 1];
}

const force = process.argv.includes("--force");
let existing = "";
try {
	existing = readFileSync(DEV_VARS_FILE, "utf8");
} catch {
	existing = "";
}
if (!force && existing && devLoginProblems(existing).length === 0) {
	process.stdout.write(
		`${DEV_VARS_FILE} already has a dev login. Pass --force to replace it.\n`,
	);
	process.exit(0);
}

let email = arg("--email")?.trim() ?? "";
let password = arg("--password") ?? "";
const interactive = input.isTTY && (!email || !password);
if (!email || !password) {
	if (!input.isTTY) {
		process.stderr.write(
			"usage: bun run dev:setup -- --email you@example.com --password secret\n",
		);
		process.exit(1);
	}
}
if (interactive) {
	const rl = createInterface({ input, output });
	try {
		if (!email) {
			email = (await rl.question("Bootstrap email: ")).trim();
		}
		if (!password) {
			password = await rl.question("Dev password: ");
		}
	} finally {
		rl.close();
	}
}
if (!email.includes("@") || password.length === 0) {
	process.stderr.write("Need an email and a non-empty password.\n");
	process.exit(1);
}

const hash = await hashDevPassword(password);
const next = upsertDevLogin(existing, {
	CADMUS_DEV_PASSWORD_LOGIN: "1",
	CADMUS_DEV_PASSWORD_HASH: hash,
	CADMUS_BOOTSTRAP_SUPER_ADMIN_EMAIL: email,
	CADMUS_DEPLOY_ENV: "development",
});
writeFileSync(DEV_VARS_FILE, next);
process.stdout.write(
	`Wrote ${DEV_VARS_FILE} for ${email}. Start the worker with bun run dev.\n`,
);
