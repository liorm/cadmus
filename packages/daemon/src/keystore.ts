import { whichOnPath } from "./confine.js";

export type TokenStorageMethod = "keychain" | "secret-service" | "file";

const SERVICE_NAME = "cadmus-daemon";

async function runProcess(
	cmd: string,
	args: string[],
	stdinInput?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		const proc = Bun.spawn([cmd, ...args], {
			stdin: stdinInput !== undefined ? "pipe" : "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		if (stdinInput !== undefined && proc.stdin) {
			proc.stdin.write(new TextEncoder().encode(stdinInput));
			proc.stdin.end();
		}
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { code, stdout, stderr };
	} catch {
		return { code: 1, stdout: "", stderr: "" };
	}
}

/**
 * Store the permanent token in the OS keystore (macOS Keychain or Linux Secret Service).
 * Returns the method used. If keystore fails or is unavailable, returns "file".
 */
export async function storeToken(
	envId: string,
	token: string,
): Promise<TokenStorageMethod> {
	if (process.platform === "darwin") {
		// Use macOS Keychain via /usr/bin/security
		// -U updates if an entry already exists, avoiding errSecDuplicateItem
		const res = await runProcess("/usr/bin/security", [
			"add-generic-password",
			"-s",
			SERVICE_NAME,
			"-a",
			envId,
			"-w",
			token,
			"-U",
		]);
		if (res.code === 0) {
			return "keychain";
		}
	} else if (process.platform === "linux") {
		if (whichOnPath("secret-tool")) {
			// Pipe token via stdin to avoid process table (/proc/$PID/cmdline) leakage
			const res = await runProcess(
				"secret-tool",
				[
					"store",
					"--label=Cadmus Daemon Token",
					"service",
					SERVICE_NAME,
					"env",
					envId,
				],
				token,
			);
			if (res.code === 0) {
				return "secret-service";
			}
		}
	}
	return "file";
}

/**
 * Retrieve the token from OS keystore.
 */
export async function retrieveToken(
	envId: string,
	method?: TokenStorageMethod,
): Promise<string | null> {
	if (method === "keychain" || (!method && process.platform === "darwin")) {
		const res = await runProcess("/usr/bin/security", [
			"find-generic-password",
			"-s",
			SERVICE_NAME,
			"-a",
			envId,
			"-w",
		]);
		if (res.code === 0) {
			return res.stdout.trim();
		}
	}
	if (
		method === "secret-service" ||
		(!method && process.platform === "linux")
	) {
		if (whichOnPath("secret-tool")) {
			const res = await runProcess("secret-tool", [
				"lookup",
				"service",
				SERVICE_NAME,
				"env",
				envId,
			]);
			if (res.code === 0) {
				return res.stdout.trim();
			}
		}
	}
	return null;
}

/**
 * Delete the token from OS keystore.
 */
export async function deleteToken(
	envId: string,
	method?: TokenStorageMethod,
): Promise<void> {
	if (method === "keychain" || (!method && process.platform === "darwin")) {
		await runProcess("/usr/bin/security", [
			"delete-generic-password",
			"-s",
			SERVICE_NAME,
			"-a",
			envId,
		]);
	}
	if (
		method === "secret-service" ||
		(!method && process.platform === "linux")
	) {
		if (whichOnPath("secret-tool")) {
			await runProcess("secret-tool", [
				"clear",
				"service",
				SERVICE_NAME,
				"env",
				envId,
			]);
		}
	}
}
