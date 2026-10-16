import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness } from "@earendil-works/pi-durable";
import type { App } from "../src/app.ts";
import {
	BotsDoc,
	createBot,
	DEFAULT_BOT_ID,
	listBots,
	SYSTEM_SEED,
} from "../src/channels/bots.ts";
import { testClockPollMs } from "../src/clock.ts";
import { DEFAULT_SOUL } from "../src/extensions/identity.ts";
import { botEnv as executionEnv } from "../src/harness/bot-env.ts";
import { createModels } from "../src/harness/models.ts";
import { buildRegistry } from "../src/harness/registry.ts";
import { openOwnedStorage } from "../src/harness/storage.ts";
import { setupLogger } from "../src/log.ts";
import { main } from "../src/main.ts";
import type { FakeEgress } from "./egress/fake-egress.ts";

export const ROOT = join(import.meta.dirname, "..");
export const PRELOAD = join(import.meta.dirname, "egress", "preload.ts");

export async function tempHome(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pi-bot-test-"));
}

/** The production env for a bot whose egress goes to `egress`. API-key auth unless overridden. */
export function botEnv(
	home: string,
	overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		PI_BOT_HOME: home,
		TELEGRAM_BOT_TOKEN: "123:test-token",
		TELEGRAM_ALLOWED_USERS: "1",
		TELEGRAM_POLL_TIMEOUT_SEC: "1",
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
 * Previous state for a test that needs a bot before `main()`. Production start creates none.
 * A row whose id is `default` is left as it is, including its files and model.
 */
export async function seedBot(
	home: string,
	options: { name?: string; model?: string; thinking?: string } = {},
): Promise<string> {
	const name = options.name ?? "Default";
	const model = options.model ?? "xai/grok-4.7";
	const thinking = options.thinking ?? "";
	const { storage, lock } = await openOwnedStorage(home);
	const { registry } = buildRegistry({
		home,
		timeZone: "UTC",
		self: { home },
	});
	const harness = await Harness.open(
		storage,
		{
			models: createModels(),
			registry,
			env: executionEnv(),
			settings: {
				steeringMode: "all",
				compaction: { enabled: true },
			},
		},
		BACKGROUND_CONTEXT,
	);
	try {
		if (name === "Default") {
			const existing = (await listBots(harness)).find(
				(bot) => bot.id === DEFAULT_BOT_ID,
			);
			if (existing) return existing.id;
			const dir = join(home, "bots", DEFAULT_BOT_ID);
			await mkdir(join(dir, "knowledge"), { recursive: true });
			await writeIfMissing(join(dir, "SOUL.md"), `${DEFAULT_SOUL}\n`);
			await writeIfMissing(join(dir, "SYSTEM.md"), `${SYSTEM_SEED}\n`);
			await harness.commit(async (tx) => {
				const bots = await tx.doc(BotsDoc);
				if (bots.items.some((bot) => bot.id === DEFAULT_BOT_ID)) return;
				bots.items.push({
					id: DEFAULT_BOT_ID,
					name: "Default",
					model,
					thinking,
					createdAt: Date.now(),
				});
			}, BACKGROUND_CONTEXT);
			return DEFAULT_BOT_ID;
		}
		const created = await createBot(harness, home, { name, model, thinking });
		if (!created.ok) throw new Error(created.error);
		return created.bot.id;
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
		await lock.release();
	}
}

/**
 * Run the real `main()` in-process. pi-ai reads provider keys from process.env, so the key under test is mirrored there
 * for the bot's lifetime.
 */
export async function startBot(
	home: string,
	overrides: Record<string, string | undefined> = {},
): Promise<App> {
	const env = botEnv(home, overrides);
	if (env.XAI_API_KEY === undefined) delete process.env.XAI_API_KEY;
	else process.env.XAI_API_KEY = env.XAI_API_KEY;
	setupLogger({ type: "silent" });
	return main(env);
}

async function writeIfMissing(path: string, text: string): Promise<void> {
	try {
		await writeFile(path, text, { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}

export async function until(
	check: () => boolean | Promise<boolean>,
	what = "condition",
	timeoutMs = 15_000,
) {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/**
 * A pinned test clock rechecks every `testClockPollMs`. Wait several of those
 * ticks before asserting that a due row did not fire.
 */
export async function waitTestClockTicks(ticks = 4): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, testClockPollMs * ticks));
}

/** Every pushed update handled, every run finished, every final answer delivered. */
export async function settle(app: App, egress: FakeEgress) {
	await until(() => egress.queuesDrained(), "the bot to confirm every update");
	await app.quiesce();
}

/** Narrow a value the test has already arranged to exist. */
export function defined<T>(value: T | null | undefined, label = "value"): T {
	if (value === null || value === undefined)
		throw new Error(`${label} is missing`);
	return value;
}

export type Child = {
	proc: ChildProcess;
	exited: Promise<number | null>;
	output: () => string;
};

/** A real `bun` process with egress routed to the fake server. */
export function spawnBun(
	args: string[],
	env: NodeJS.ProcessEnv,
	egress: FakeEgress,
): Child {
	const proc = spawn(process.execPath, ["--preload", PRELOAD, ...args], {
		cwd: ROOT,
		env: { ...env, EGRESS_URL: egress.url },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	const { stdout, stderr } = proc;
	if (!stdout || !stderr) throw new Error("spawned bun has no pipes");
	stdout.on("data", (chunk) => (output += chunk));
	stderr.on("data", (chunk) => (output += chunk));
	const exited = new Promise<number | null>((resolve) =>
		proc.on("exit", (code, signal) => resolve(signal ? -1 : code)),
	);
	return { proc, exited, output: () => output };
}
