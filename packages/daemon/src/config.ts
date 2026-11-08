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

export function normalizeConfigKey(key: string): keyof DaemonConfig | "token" {
	const trimmed = key.trim().toLowerCase();
	if (trimmed === "url") return "url";
	if (trimmed === "envid" || trimmed === "env-id" || trimmed === "env_id")
		return "envId";
	if (trimmed === "name") return "name";
	if (trimmed === "persist") return "persist";
	if (
		trimmed === "confine" ||
		trimmed === "confinetoworkspace" ||
		trimmed === "confine-to-workspace" ||
		trimmed === "confine_to_workspace"
	)
		return "confineToWorkspace";
	if (trimmed === "token") return "token";
	throw new Error(
		`Unknown configuration key '${key}'. Valid keys are: url, token, env-id, name, persist, confine`,
	);
}

export async function setDaemonConfigValue(
	key: string,
	value: string,
	customPath?: string,
): Promise<{ configPath: string; key: string; value: unknown }> {
	const normalizedKey = normalizeConfigKey(key);
	const loaded = await loadDaemonConfig(customPath);
	if (!loaded) {
		const configPath = customPath || defaultDaemonConfigPath();
		throw new Error(
			`Configuration file not found at ${configPath}. Create one with 'cadmus-daemon pair <token>' or specify --save with 'cadmus-daemon start'`,
		);
	}

	let parsedValue: unknown;
	if (normalizedKey === "persist" || normalizedKey === "confineToWorkspace") {
		const v = value.trim().toLowerCase();
		if (v !== "true" && v !== "false" && v !== "1" && v !== "0") {
			throw new Error(
				`Invalid boolean value '${value}' for ${key}. Use 'true' or 'false'.`,
			);
		}
		parsedValue = v === "true" || v === "1";
	} else {
		parsedValue = value;
	}

	const params = {
		url: normalizedKey === "url" ? (parsedValue as string) : loaded.config.url,
		envId:
			normalizedKey === "envId" ? (parsedValue as string) : loaded.config.envId,
		persist:
			normalizedKey === "persist"
				? (parsedValue as boolean)
				: loaded.config.persist,
		confineToWorkspace:
			normalizedKey === "confineToWorkspace"
				? (parsedValue as boolean)
				: loaded.config.confineToWorkspace,
		name:
			normalizedKey === "name" ? (parsedValue as string) : loaded.config.name,
		token: normalizedKey === "token" ? (parsedValue as string) : loaded.token,
	};

	const { configPath } = await saveDaemonConfig(params, customPath);
	return { configPath, key: normalizedKey, value: parsedValue };
}

export async function getDaemonConfigValue(
	key?: string,
	customPath?: string,
): Promise<{ configPath: string; value: unknown }> {
	const configPath = customPath || defaultDaemonConfigPath();
	const loaded = await loadDaemonConfig(customPath);
	if (!loaded) {
		throw new Error(
			`Configuration file not found at ${configPath}. Run 'cadmus-daemon pair <token>' first.`,
		);
	}
	if (!key) {
		return {
			configPath,
			value: {
				...loaded.config,
				token: loaded.token ? `${loaded.token.slice(0, 10)}...` : undefined,
			},
		};
	}
	const normalizedKey = normalizeConfigKey(key);
	if (normalizedKey === "token") {
		return { configPath, value: loaded.token };
	}
	return { configPath, value: loaded.config[normalizedKey] };
}
