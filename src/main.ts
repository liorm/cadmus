import { type App, startApp } from "./app.ts";
import { GrammyTransport } from "./channels/telegram/transport.ts";
import { configFromEnv } from "./config.ts";
import { FileCredentialStore } from "./harness/credentials.ts";
import { checkModel, createModels } from "./harness/models.ts";
import { getLogger, loggerInstalled, setupLogger } from "./log.ts";

/** Start pi-bot from environment variables. Throws on bad configuration or unusable model credentials. */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<App> {
	const config = configFromEnv(env);
	if (!loggerInstalled()) setupLogger({ type: "console", level: config.logLevel });
	const log = getLogger();
	if (!config.telegram.token && !config.web) throw new Error("Set TELEGRAM_BOT_TOKEN or WEB_TOKEN (see .env.example)");
	if (config.telegram.token) {
		if (config.telegram.allowedUsers.size === 0)
			log.warn("TELEGRAM_ALLOWED_USERS is empty: every incoming message will be ignored");
	} else {
		log.info("TELEGRAM_BOT_TOKEN is unset; the general Telegram door is off");
	}

	// OAuth logins (bun run login <provider>) live in <home>/auth.json; API keys still come from env vars.
	const models = createModels({ credentials: FileCredentialStore.inHome(config.home) });
	log.info(`Model auth: ${await checkModel(models, config.model.main)}`);

	const transport = config.telegram.token
		? new GrammyTransport(config.telegram.token, config.telegram.apiRoot ? { apiRoot: config.telegram.apiRoot } : {})
		: undefined;
	const app = await startApp({ config, models, ...(transport ? { transport } : {}) });
	for (const unknown of app.unknownAtStartup)
		log.warn(`Reply in chat ${unknown.chat} may not have been delivered (${unknown.key}); it will not be resent`);
	return app;
}

if (import.meta.main) {
	setupLogger({ type: "console", level: process.env.LOG_LEVEL ?? "info" });
	let app: App;
	try {
		app = await main(process.env);
	} catch (error) {
		getLogger().error((error as Error).message);
		process.exit(1);
	}
	let signals = 0;
	const shutdown = (signal: string) => {
		if (++signals > 1) process.exit(1);
		getLogger().info(`${signal}: shutting down`);
		app.stop().then(
			() => process.exit(0),
			(error) => {
				getLogger().error("shutdown failed", { error });
				process.exit(1);
			},
		);
	};
	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
}
