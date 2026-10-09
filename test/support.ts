import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "../src/app.ts";
import { silentLogger } from "../src/log.ts";
import { main } from "../src/main.ts";
import type { FakeEgress } from "./egress/fake-egress.ts";

export const ROOT = join(import.meta.dirname, "..");
export const PRELOAD = join(import.meta.dirname, "egress", "preload.ts");

export async function tempHome(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pi-bot-test-"));
}

/** The production env for a bot whose egress goes to `egress`. API-key auth unless overridden. */
export function botEnv(home: string, overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		PI_BOT_HOME: home,
		TELEGRAM_BOT_TOKEN: "123:test-token",
		TELEGRAM_ALLOWED_USERS: "1",
		TELEGRAM_POLL_TIMEOUT_SEC: "1",
		PI_MODEL: "xai/grok-4.7",
		XAI_API_KEY: "test-api-key",
		PI_BOT_TZ: "Asia/Jerusalem",
		PI_BOT_DELIVERY_SWEEP_MS: "200",
		LOG_LEVEL: "warn",
	};
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) delete env[key];
		else env[key] = value;
	}
	return env;
}

/**
 * Run the real `main()` in-process. pi-ai reads provider keys from process.env, so the key under test is mirrored there
 * for the bot's lifetime.
 */
export async function startBot(home: string, overrides: Record<string, string | undefined> = {}): Promise<App> {
	const env = botEnv(home, overrides);
	if (env.XAI_API_KEY === undefined) delete process.env.XAI_API_KEY;
	else process.env.XAI_API_KEY = env.XAI_API_KEY;
	return main(env, silentLogger);
}

export async function until(check: () => boolean | Promise<boolean>, what = "condition", timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** Every pushed update handled, every run finished, every final answer delivered. */
export async function settle(app: App, egress: FakeEgress) {
	await until(() => egress.telegram.drained(), "the bot to confirm every update");
	await app.quiesce();
}

export type Child = { proc: ChildProcess; exited: Promise<number | null>; output: () => string };

/** A real `bun` process with egress routed to the fake server. */
export function spawnBun(args: string[], env: NodeJS.ProcessEnv, egress: FakeEgress): Child {
	const proc = spawn(process.execPath, ["--preload", PRELOAD, ...args], {
		cwd: ROOT,
		env: { ...env, EGRESS_URL: egress.url },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	proc.stdout!.on("data", (chunk) => (output += chunk));
	proc.stderr!.on("data", (chunk) => (output += chunk));
	const exited = new Promise<number | null>((resolve) => proc.on("exit", (code, signal) => resolve(signal ? -1 : code)));
	return { proc, exited, output: () => output };
}
