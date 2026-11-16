/**
 * Browser engine selection for UI-flow tests.
 *
 * Default: Obscura (spike 2026-11-03: both engines can be selected; Obscura
 * is the default when a binary is present, Chrome is the documented fallback).
 *
 * --engine=obscura|lightpanda|chrome  or  CADMUS_TEST_ENGINE
 * CADMUS_TEST_CDP_URL skips launching and connects to an existing CDP endpoint.
 *
 * Known gaps (do not call engine APIs from tests; use actions.ts):
 * - Obscura #45: Playwright locator click/fill can time out.
 * - Obscura 0.2.3: selectOption breaks; shadow DOM clicks miss; IndexedDB empty.
 * - Lightpanda 0.4.1: one context per CDP connection; --load-resources for CSS.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type EngineName = "obscura" | "lightpanda" | "chrome";

const here = dirname(fileURLToPath(import.meta.url));
const engineDir = resolve(here, "../../.engine");
export const CDP_URL_FILE = resolve(engineDir, "cdp-url");
export const ENGINE_PID_FILE = resolve(engineDir, "engine.pid");

export function parseEngine(argv = process.argv): EngineName {
	const flag = argv.find((arg) => arg.startsWith("--engine="));
	const fromFlag = flag?.slice("--engine=".length);
	const fromEnv = process.env.CADMUS_TEST_ENGINE;
	const raw = (fromFlag ?? fromEnv ?? "obscura").toLowerCase();
	if (raw === "lightpanda" || raw === "chrome" || raw === "obscura") {
		return raw;
	}
	return "obscura";
}

export function cdpUrlFromEnv(): string | undefined {
	const url = process.env.CADMUS_TEST_CDP_URL?.trim();
	return url ? url : undefined;
}

export function obscuraBinary(): string | undefined {
	const named = process.env.CADMUS_TEST_OBSCURA;
	if (named && existsSync(named)) return named;
	const local = resolve(engineDir, "obscura");
	if (existsSync(local)) return local;
	return undefined;
}

export function lightpandaBinary(): string | undefined {
	const named = process.env.CADMUS_TEST_LIGHTPANDA;
	if (named && existsSync(named)) return named;
	const local = resolve(engineDir, "lightpanda");
	if (existsSync(local)) return local;
	return undefined;
}

export type EngineHandle = {
	name: EngineName;
	cdpUrl?: string;
	process?: ChildProcess;
	stop: () => Promise<void>;
};

function waitForPort(url: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolveWait, reject) => {
		const tick = async () => {
			try {
				await fetch(url, { signal: AbortSignal.timeout(500) });
				resolveWait();
				return;
			} catch {
				if (Date.now() > deadline) {
					reject(new Error(`CDP endpoint not ready: ${url}`));
					return;
				}
				setTimeout(() => {
					void tick();
				}, 150);
			}
		};
		void tick();
	});
}

export function isPerWorkerEngine(name: EngineName): boolean {
	if (name !== "obscura") return false;
	const override = process.env.CADMUS_PER_WORKER_ENGINE?.trim();
	if (override === "0") return false;
	return true;
}

export async function startEngineOnPort(
	name: EngineName,
	port: number,
	options: { writePidFile?: boolean } = {},
): Promise<EngineHandle> {
	if (name === "chrome") {
		return { name, stop: async () => undefined };
	}
	const cdpUrl = `http://127.0.0.1:${port}`;
	if (name === "obscura") {
		const bin = obscuraBinary();
		if (!bin) {
			throw new Error(
				"Obscura binary missing. Place it at packages/web-app/.engine/obscura or use --engine=chrome.",
			);
		}
		const child = spawn(
			bin,
			["serve", "-p", String(port), "--allow-private-network"],
			{ stdio: "ignore" },
		);
		try {
			await waitForPort(`${cdpUrl}/json/version`, 15_000);
		} catch (error) {
			child.kill("SIGTERM");
			throw error;
		}
		if (options.writePidFile && child.pid) {
			mkdirSync(engineDir, { recursive: true });
			writeFileSync(ENGINE_PID_FILE, String(child.pid), "utf8");
		}
		return {
			name,
			cdpUrl,
			process: child,
			stop: async () => {
				if (child.exitCode !== null || child.signalCode !== null) return;
				await new Promise<void>((resolveStop) => {
					const timer = setTimeout(() => {
						try {
							child.kill("SIGKILL");
						} catch {
							/* already gone */
						}
						resolveStop();
					}, 2_000);
					child.once("exit", () => {
						clearTimeout(timer);
						resolveStop();
					});
					try {
						child.kill("SIGTERM");
					} catch {
						clearTimeout(timer);
						resolveStop();
					}
				});
			},
		};
	}
	const bin = lightpandaBinary();
	if (!bin) {
		throw new Error(
			"Lightpanda binary missing. Place it at packages/web-app/.engine/lightpanda or use --engine=chrome.",
		);
	}
	const child = spawn(bin, ["--dump", `--port=${port}`, "--load-resources"], {
		stdio: "ignore",
	});
	await waitForPort(`${cdpUrl}/json/version`, 15_000).catch(async () => {
		await waitForPort(cdpUrl, 5_000);
	});
	if (options.writePidFile && child.pid) {
		mkdirSync(engineDir, { recursive: true });
		writeFileSync(ENGINE_PID_FILE, String(child.pid), "utf8");
	}
	return {
		name,
		cdpUrl,
		process: child,
		stop: async () => {
			child.kill("SIGTERM");
		},
	};
}

export async function startEngine(name: EngineName): Promise<EngineHandle> {
	const existing = cdpUrlFromEnv();
	if (existing) {
		return { name, cdpUrl: existing, stop: async () => undefined };
	}
	const port = Number(process.env.CADMUS_TEST_CDP_PORT ?? "9222");
	return startEngineOnPort(name, port, { writePidFile: true });
}
