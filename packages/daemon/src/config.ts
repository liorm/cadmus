import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import {
	deleteToken,
	retrieveToken,
	storeToken,
	type TokenStorageMethod,
} from "./keystore.js";

export interface DaemonConfig {
	url: string;
	envId: string;
	workspacePath: string;
	persist: boolean;
	confineToWorkspace: boolean;
	name?: string;
	tokenStorageMethod: TokenStorageMethod;
	token?: string;
}

export function defaultDaemonConfigPath(): string {
	if (process.env.CADMUS_DAEMON_CONFIG?.trim()) {
		return process.env.CADMUS_DAEMON_CONFIG.trim();
	}
	return join(os.homedir(), ".cadmus", "daemon.json");
}

export async function saveDaemonConfig(
	params: {
		url: string;
		envId: string;
		workspacePath: string;
		persist: boolean;
		confineToWorkspace: boolean;
		name?: string;
		token: string;
	},
	customPath?: string,
): Promise<{ configPath: string; storageMethod: TokenStorageMethod }> {
	const configPath = customPath || defaultDaemonConfigPath();
	const dir = dirname(configPath);
	if (!existsSync(dir)) {
		await mkdir(dir, { recursive: true, mode: 0o700 });
		try {
			await chmod(dir, 0o700);
		} catch {
			// ignore on non-posix
		}
	}
	const storageMethod = await storeToken(params.envId, params.token);
	const configData: DaemonConfig = {
		url: params.url,
		envId: params.envId,
		workspacePath: params.workspacePath,
		persist: params.persist,
		confineToWorkspace: params.confineToWorkspace,
		name: params.name,
		tokenStorageMethod: storageMethod,
		...(storageMethod === "file" ? { token: params.token } : {}),
	};
	const content = JSON.stringify(configData, null, 2);
	await writeFile(configPath, content, { encoding: "utf-8", mode: 0o600 });
	try {
		await chmod(configPath, 0o600);
	} catch {
		// ignore on non-posix
	}
	return { configPath, storageMethod };
}

export async function loadDaemonConfig(
	customPath?: string,
): Promise<{ config: DaemonConfig; token: string } | null> {
	const configPath = customPath || defaultDaemonConfigPath();
	if (!existsSync(configPath)) {
		return null;
	}
	const content = await readFile(configPath, "utf-8");
	const config = JSON.parse(content) as DaemonConfig;
	let token: string | null = null;
	if (config.tokenStorageMethod === "file") {
		token = config.token ?? null;
	} else {
		token = await retrieveToken(config.envId, config.tokenStorageMethod);
		if (!token && config.token) {
			token = config.token;
		}
	}
	if (!token) {
		throw new Error(
			`Daemon credentials not found in ${config.tokenStorageMethod}. Re-pair using: cadmus-daemon pair <token>`,
		);
	}
	return { config, token };
}

export async function deleteDaemonConfig(
	customPath?: string,
): Promise<boolean> {
	const configPath = customPath || defaultDaemonConfigPath();
	if (!existsSync(configPath)) {
		return false;
	}
	try {
		const content = await readFile(configPath, "utf-8");
		const config = JSON.parse(content) as DaemonConfig;
		await deleteToken(config.envId, config.tokenStorageMethod);
	} catch {
		// ignore
	}
	await unlink(configPath);
	return true;
}
