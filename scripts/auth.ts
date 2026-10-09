// bun run login <provider>   OAuth login (e.g. `bun run login grok` = xAI SuperGrok / X Premium, device code)
// bun run logout <provider>  remove the stored credential
// bun run auth:status        list stored credentials (types only, never secrets) and verify they resolve
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { FileCredentialStore } from "../src/harness/credentials.ts";
import { loginProvider, resolveProviderId } from "../src/harness/login.ts";
import { createModels } from "../src/harness/models.ts";

const [command, name] = process.argv.slice(2);
const home = resolve(process.env.PI_BOT_HOME ?? "./data");
const store = FileCredentialStore.inHome(home);
const models = createModels(undefined, { credentials: store });

async function main() {
	if (command === "status") {
		const stored = await store.list();
		if (!stored.length) console.log(`No stored credentials in ${store.path}`);
		for (const { providerId, type } of stored) {
			try {
				const auth = await models.getAuth(providerId);
				console.log(`${providerId}: ${type} — ${auth ? `ok (${auth.source ?? "resolved"})` : "not usable"}`);
			} catch (error) {
				console.log(`${providerId}: ${type} — FAILED: ${(error as Error).message}`);
			}
		}
		return;
	}
	if (!name) throw new Error(`usage: bun run ${command === "logout" ? "logout" : "login"} <provider>   (e.g. grok)`);
	const providerId = resolveProviderId(name);
	if (command === "logout") {
		await models.logout(providerId);
		console.log(`Removed ${providerId} credential from ${store.path}`);
		return;
	}
	if (command !== "login") throw new Error(`unknown command ${command}`);
	const abort = new AbortController();
	process.on("SIGINT", () => abort.abort());
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		await loginProvider(models, providerId, {
			signal: abort.signal,
			print: (text) => console.log(`\n${text}`),
			ask: async (prompt) => {
				if (prompt.type === "select") {
					prompt.options.forEach((option, i) => console.log(`  ${i + 1}. ${option.label}`));
					const answer = await rl.question(`${prompt.message} [1-${prompt.options.length}]: `);
					return prompt.options[Number(answer) - 1]?.id ?? answer;
				}
				return rl.question(`${prompt.message}: `);
			},
		});
	} finally {
		rl.close();
	}
	const auth = await models.getAuth(providerId);
	console.log(`\nLogged in: ${providerId} credential stored in ${store.path} (${auth?.source ?? "?"}). Tokens refresh automatically.`);
}

main().then(
	() => process.exit(0),
	(error) => {
		console.error(`Error: ${(error as Error).message}`);
		process.exit(1);
	},
);
