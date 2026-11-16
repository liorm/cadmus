/**
 * Prints a CADMUS_DEV_PASSWORD_HASH for local development.
 * Usage: bun scripts/hash-dev-password.ts <password>
 * Put the result in packages/worker/.dev.vars with CADMUS_DEV_PASSWORD_LOGIN=1.
 * Then start the worker with `bun run dev`, which passes CADMUS_DEPLOY_ENV=development.
 * Plain `wrangler dev` refuses dev-password login. Never put the hash in wrangler.jsonc.
 */
import { hashDevPassword } from "../packages/worker/src/auth/dev-password.ts";

const password = process.argv[2];
if (!password) {
	process.stderr.write("usage: bun scripts/hash-dev-password.ts <password>\n");
	process.exit(1);
}
process.stdout.write(`${await hashDevPassword(password)}\n`);
