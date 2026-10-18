import { type App, startApp } from "./app.ts";
import { configFromEnv } from "./config.ts";
import { FileCredentialStore } from "./harness/credentials.ts";
import { createModels } from "./harness/models.ts";
import { getLogger, loggerInstalled, setupLogger } from "./log.ts";

/** Start pi-bot from environment variables. Throws on bad configuration or unusable model credentials. */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<App> {
	const config = configFromEnv(env);
	if (!loggerInstalled())
		setupLogger({ type: "console", level: config.logLevel });
	if (!config.web) throw new Error("Set WEB_TOKEN (see .env.example)");

	// OAuth logins (bun run login <provider>) live in <home>/auth.json; API keys still come from env vars.
	const models = createModels({
		credentials: FileCredentialStore.inHome(config.home),
	});

	return startApp({
		config,
		models,
	});
}

if (import.meta.main) {
	setupLogger({ type: "console", level: process.env.LOG_LEVEL });
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
