import { startApp } from "./app.ts";
import { GrammyTransport } from "./channels/telegram/transport.ts";
import { configFromEnv } from "./config.ts";
import { FileCredentialStore } from "./harness/credentials.ts";
import { checkModel, createModels } from "./harness/models.ts";
import { consoleLogger } from "./log.ts";

const config = configFromEnv();
const log = consoleLogger(config.logLevel);
if (!config.telegram.token) {
	log.error("TELEGRAM_BOT_TOKEN is not set (see .env.example)");
	process.exit(1);
}
if (config.telegram.allowedUsers.size === 0)
	log.warn("TELEGRAM_ALLOWED_USERS is empty: every incoming message will be ignored");

// OAuth logins (bun run login <provider>) live in <home>/auth.json; API keys still come from env vars.
const models = createModels(undefined, { credentials: FileCredentialStore.inHome(config.home) });
try {
	log.info(`Model auth: ${await checkModel(models, config.model.main)}`);
} catch (error) {
	log.error((error as Error).message);
	process.exit(1);
}

const app = await startApp({ config, models, transport: new GrammyTransport(config.telegram.token), log });
for (const unknown of app.unknownAtStartup)
	log.warn(`Reply in chat ${unknown.chat} may not have been delivered (${unknown.key}); it will not be resent`);

let signals = 0;
const shutdown = (signal: string) => {
	if (++signals > 1) process.exit(1);
	log.info(`${signal}: shutting down`);
	app.stop().then(
		() => process.exit(0),
		(error) => {
			log.error("shutdown failed", error);
			process.exit(1);
		},
	);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
