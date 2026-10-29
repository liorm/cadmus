#!/usr/bin/env bun
import { resolve } from "node:path";
import { stdout } from "node:process";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { daemonCliArgs, formatDaemonHelp, parseDaemonArgs } from "./args.js";
import { createBackoff, noteAttempt } from "./backoff.js";
import { deleteDaemonConfig, loadDaemonConfig } from "./config.js";
import {
	type ConfineDetector,
	detectConfineMechanisms,
	startupDecision,
} from "./confine.js";
import { type DaemonLogger, getDaemonLogger } from "./log.js";
import { performPairing } from "./pair.js";
import { DaemonSession } from "./session.js";
import { type DaemonSocket, openDaemonSocket } from "./socket.js";
import { DAEMON_VERSION } from "./version.js";
import { prepareWorkspace } from "./workspace.js";

export interface RunDaemonOptions {
	url: string;
	token: string;
	envId: string;
	workspacePath: string;
	persist: boolean;
	confineToWorkspace: boolean;
	detector?: ConfineDetector;
	logger?: DaemonLogger;
	configStamp?: string;
	signal?: AbortSignal;
	onWarning?: (line: string) => void;
	sleep?: (ms: number) => Promise<void>;
	random?: () => number;
	dial?: (input: {
		url: string;
		headers: Record<string, string>;
	}) => Promise<{ status: number; socket?: DaemonSocket }>;
}

export async function runDaemon(options: RunDaemonOptions): Promise<void> {
	const logger = options.logger ?? getDaemonLogger();
	const detector = options.detector ?? detectConfineMechanisms();
	const decision = startupDecision({
		confineToWorkspace: options.confineToWorkspace,
		detector,
	});
	if (!decision.start) {
		throw new Error(decision.reason);
	}
	if (decision.warning) {
		if (options.onWarning) options.onWarning(decision.warning);
		else logger.warn(decision.warning);
	}
	const state = createBackoff(options.configStamp ?? configStamp(options));
	const dial = options.dial ?? openDaemonSocket;
	const sleep =
		options.sleep ??
		((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
	const random = options.random ?? Math.random;
	let prepared = false;
	let cwd = options.workspacePath;
	let execution: NodeExecutionEnv | undefined;
	while (!options.signal?.aborted) {
		if (state.stopped) return;
		if (!prepared || !execution) {
			cwd = prepareWorkspace(options.workspacePath, options.persist);
			execution = new NodeExecutionEnv({ cwd });
			prepared = true;
		}
		const headers: Record<string, string> = {
			Authorization: `Bearer ${options.token}`,
			"X-Cadmus-Workspace": cwd,
		};
		if (decision.capability)
			headers["X-Cadmus-Env-Capabilities"] = "confinement";
		const url = new URL(options.url);
		if (!url.searchParams.get("envId"))
			url.searchParams.set("envId", options.envId);
		let opened: { status: number; socket?: DaemonSocket };
		try {
			opened = await dial({ url: url.toString(), headers });
		} catch (error) {
			// ECONNREFUSED, DNS, reset, and the connect timeout reject the dial.
			// Those are retryable (status 0), same backoff as a non-101 response.
			if (options.signal?.aborted) return;
			const failed = noteAttempt(state, 0, random);
			if (failed.action === "stop") return;
			if (failed.action === "wait") {
				logger.warn("daemon.connectFailed", {
					error: error instanceof Error ? error.message : String(error),
					retryInMs: failed.delayMs,
				});
				await sleep(failed.delayMs);
			}
			continue;
		}
		if (options.signal?.aborted) return;
		const step = noteAttempt(state, opened.status, random);
		if (step.action === "stop") {
			logger.error("daemon.stopped", {
				status: opened.status,
				reason: step.reason,
			});
			return;
		}
		if (step.action === "wait") {
			logger.warn("daemon.connectRejected", {
				status: opened.status,
				retryInMs: step.delayMs,
			});
			await sleep(step.delayMs);
			continue;
		}
		if (!opened.socket || !execution) return;
		await runSocket(opened.socket, execution, cwd, options, detector);
	}
}

async function runSocket(
	socket: DaemonSocket,
	execution: NodeExecutionEnv,
	cwd: string,
	options: RunDaemonOptions,
	detector: ConfineDetector,
): Promise<void> {
	const logger = options.logger ?? getDaemonLogger();
	logger.info("session.connected", { cwd });
	const session = new DaemonSession(execution, {
		cwd,
		ephemeralDir: options.persist ? undefined : cwd,
		confineToWorkspace: options.confineToWorkspace,
		mechanism: detector,
		logger,
	});
	session.attach(socket);
	socket.onMessage((text) => session.handleText(text));
	socket.onClose(() => {
		logger.info("session.disconnected");
		session.dispose();
	});
	await socket.closed;
	session.dispose();
}

function configStamp(options: RunDaemonOptions): string {
	return JSON.stringify({
		envId: options.envId,
		workspacePath: options.workspacePath,
		persist: options.persist,
		confineToWorkspace: options.confineToWorkspace,
	});
}

async function main(): Promise<void> {
	const logger = getDaemonLogger();
	const parsed = parseDaemonArgs(daemonCliArgs(process.argv));
	if (parsed.kind === "help") {
		stdout.write(`${formatDaemonHelp()}\n`);
		return;
	}
	if (parsed.kind === "version") {
		stdout.write(`${DAEMON_VERSION}\n`);
		return;
	}
	if (parsed.kind === "error") {
		throw new Error(parsed.message);
	}
	if (parsed.kind === "deregister") {
		const removed = await deleteDaemonConfig(parsed.configPath);
		if (removed) {
			logger.info("daemon.deregistered", {
				configPath: parsed.configPath,
			});
		} else {
			logger.info("daemon.deregisterSkipped", {
				reason: "no_local_config",
				configPath: parsed.configPath,
			});
		}
		return;
	}
	if (parsed.kind === "pair") {
		const workspacePath = resolveDaemonWorkspace(parsed.workspace);
		const options = await performPairing({
			pairingToken: parsed.token,
			name: parsed.name,
			workspacePath,
			customConfigPath: parsed.configPath,
			logger,
		});
		logger.info("daemon.starting", {
			envId: options.envId,
			workspace: workspacePath,
			url: options.url,
			persist: options.persist,
			confineToWorkspace: options.confineToWorkspace,
		});
		await runDaemon(options);
		return;
	}
	if (parsed.kind === "start") {
		const loaded = await loadDaemonConfig(parsed.configPath);
		if (!loaded) {
			logger.error("daemon.notPaired", {
				hint: "cadmus-daemon pair <token> [--name 'My Machine']",
			});
			process.exitCode = 1;
			return;
		}
		const workspacePath = resolveDaemonWorkspace(parsed.workspace);
		logger.info("daemon.starting", {
			name: loaded.config.name || loaded.config.envId,
			envId: loaded.config.envId,
			workspace: workspacePath,
			url: loaded.config.url,
			persist: loaded.config.persist,
			confineToWorkspace: loaded.config.confineToWorkspace,
		});
		await runDaemon({
			url: loaded.config.url,
			token: loaded.token,
			envId: loaded.config.envId,
			workspacePath,
			persist: loaded.config.persist,
			confineToWorkspace: loaded.config.confineToWorkspace,
			logger,
		});
		return;
	}
}

export function resolveDaemonWorkspace(flag: string | undefined): string {
	const trimmed = flag?.trim();
	return resolve(trimmed && trimmed.length > 0 ? trimmed : process.cwd());
}

if (import.meta.main) {
	void main().catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		getDaemonLogger().error("daemon.fatal", { error: message });
		process.exitCode = 1;
	});
}
