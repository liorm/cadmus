/**
 * Copy the new app into packages/web/dist/app so wrangler can serve it
 * under /app/ without replacing the existing SPA. Run after `web:build`.
 */
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDist = resolve(here, "../dist");
const webDist = resolve(here, "../../web/dist");
const webDistApp = resolve(webDist, "app");

if (!existsSync(appDist)) {
	throw new Error(`app dist missing: ${appDist}`);
}
if (!existsSync(webDist)) {
	throw new Error(
		`web dist missing (run web:build before web-app:build): ${webDist}`,
	);
}

rmSync(webDistApp, { recursive: true, force: true });
cpSync(appDist, webDistApp, { recursive: true });
process.stdout.write(`copied ${appDist} -> ${webDistApp}\n`);
