import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SecretStore {
	get(origin: string): Promise<string | undefined>;
	set(origin: string, refreshToken: string): Promise<void>;
	delete(origin: string): Promise<void>;
}

interface CredentialFile {
	version: 1;
	origins: Record<string, { refreshToken: string }>;
}

export function createMemorySecretStore(): SecretStore {
	const origins = new Map<string, string>();
	return {
		async get(origin) {
			return origins.get(origin);
		},
		async set(origin, refreshToken) {
			origins.set(origin, refreshToken);
		},
		async delete(origin) {
			origins.delete(origin);
		},
	};
}

export function createFileSecretStore(path: string): SecretStore {
	return {
		get: (origin) => readOrigin(path, origin),
		set: (origin, refreshToken) => writeOrigin(path, origin, refreshToken),
		delete: (origin) => writeOrigin(path, origin, undefined),
	};
}

async function readFileJson(path: string): Promise<CredentialFile> {
	try {
		const text = await readFile(path, "utf8");
		const parsed = JSON.parse(text) as CredentialFile;
		if (parsed.version !== 1 || typeof parsed.origins !== "object") {
			return { version: 1, origins: {} };
		}
		return parsed;
	} catch {
		return { version: 1, origins: {} };
	}
}

async function readOrigin(
	path: string,
	origin: string,
): Promise<string | undefined> {
	const file = await readFileJson(path);
	const token = file.origins[origin]?.refreshToken;
	return typeof token === "string" && token.length > 0 ? token : undefined;
}

async function writeOrigin(
	path: string,
	origin: string,
	refreshToken: string | undefined,
): Promise<void> {
	const file = await readFileJson(path);
	if (refreshToken === undefined) delete file.origins[origin];
	else file.origins[origin] = { refreshToken };
	await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
	await writeFile(path, `${JSON.stringify(file)}\n`, { mode: 0o600 });
	await chmod(path, 0o600);
}

function commandExists(name: string): boolean {
	const found = spawnSync("sh", ["-c", `command -v ${name}`], {
		encoding: "utf8",
	});
	return found.status === 0;
}

function keychainGet(origin: string): string | undefined {
	if (process.platform === "darwin" && commandExists("security")) {
		const result = spawnSync(
			"security",
			["find-generic-password", "-s", "cadmus", "-a", origin, "-w"],
			{ encoding: "utf8" },
		);
		if (result.status !== 0) return undefined;
		const token = result.stdout.trim();
		return token.length > 0 ? token : undefined;
	}
	if (process.platform === "linux" && commandExists("secret-tool")) {
		const result = spawnSync(
			"secret-tool",
			["lookup", "service", "cadmus", "origin", origin],
			{ encoding: "utf8" },
		);
		if (result.status !== 0) return undefined;
		const token = result.stdout.trim();
		return token.length > 0 ? token : undefined;
	}
	return undefined;
}

function keychainSet(origin: string, refreshToken: string): boolean {
	if (process.platform === "darwin" && commandExists("security")) {
		const result = spawnSync(
			"security",
			[
				"add-generic-password",
				"-s",
				"cadmus",
				"-a",
				origin,
				"-w",
				refreshToken,
				"-U",
			],
			{ encoding: "utf8" },
		);
		return result.status === 0;
	}
	if (process.platform === "linux" && commandExists("secret-tool")) {
		const result = spawnSync(
			"secret-tool",
			["store", "--label", "cadmus", "service", "cadmus", "origin", origin],
			{ encoding: "utf8", input: refreshToken },
		);
		return result.status === 0;
	}
	return false;
}

function keychainDelete(origin: string): void {
	if (process.platform === "darwin" && commandExists("security")) {
		spawnSync(
			"security",
			["delete-generic-password", "-s", "cadmus", "-a", origin],
			{ encoding: "utf8" },
		);
		return;
	}
	if (process.platform === "linux" && commandExists("secret-tool")) {
		spawnSync("secret-tool", ["clear", "service", "cadmus", "origin", origin], {
			encoding: "utf8",
		});
	}
}

/** Keychain when the OS tool works, otherwise the user-only file. */
export function createDefaultSecretStore(
	filePath = join(homedir(), ".config", "cadmus", "credentials.json"),
): SecretStore {
	const file = createFileSecretStore(filePath);
	return {
		async get(origin) {
			return keychainGet(origin) ?? (await file.get(origin));
		},
		async set(origin, refreshToken) {
			if (!keychainSet(origin, refreshToken))
				await file.set(origin, refreshToken);
			else await file.delete(origin);
		},
		async delete(origin) {
			keychainDelete(origin);
			await file.delete(origin);
		},
	};
}
