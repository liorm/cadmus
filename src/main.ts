import { type App, startApp } from "./app.ts";
import { GrammyTransport } from "./channels/telegram/transport.ts";
import { configFromEnv } from "./config.ts";
import { FileCredentialStore } from "./harness/credentials.ts";
import { checkModel, createModels } from "./harness/models.ts";
import { consoleLogger, type Logger } from "./log.ts";

/** Start pi-bot from environment variables. Throws on bad configuration or unusable model credentials. */
export async function main(env: NodeJS.ProcessEnv = process.env, logger?: Logger): Promise<App> {
	const config = configFromEnv(env);
	const log = logger ?? consoleLogger(config.logLevel);
	if (!config.telegram.token) throw new Error("TELEGRAM_BOT_TOKEN is not set (see .env.example)");
	if (config.telegram.allowedUsers.size === 0)
		log.warn("TELEGRAM_ALLOWED_USERS is empty: every incoming message will be ignored");

	// OAuth logins (bun run login <provider>) live in <home>/auth.json; API keys still come from env vars.
	const models = createModels({ credentials: FileCredentialStore.inHome(config.home) });
	log.info(`Model auth: ${await checkModel(models, config.model.main)}`);

	const transport = new GrammyTransport(config.telegram.token, config.telegram.apiRoot ? { apiRoot: config.telegram.apiRoot } : {});
	const app = await startApp({ config, models, transport, log });
	for (const unknown of app.unknownAtStartup)
		log.warn(`Reply in chat ${unknown.chat} may not have been delivered (${unknown.key}); it will not be resent`);
	return app;
}

if (import.meta.main) {
	const log = consoleLogger(process.env.LOG_LEVEL ?? "info");
	let app: App;
	try {
		app = await main(process.env, log);
	} catch (error) {
		log.error((error as Error).message);
		process.exit(1);
	}
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
}
