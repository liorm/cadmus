import { spawn } from "node:child_process";
import { mkdir, rmdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createClient } from "./client.js";
import {
	EXIT_OK,
	EXIT_PROTOCOL,
	EXIT_TRANSPORT,
	EXIT_USAGE,
} from "./exit-codes.js";
import type { SecretStore } from "./secret-store.js";

export interface LoginIO {
	origin: string;
	pretty: boolean;
	store: SecretStore;
	fetchImpl?: typeof fetch;
	device: boolean;
	devPassword: boolean;
	password?: string;
	email?: string;
	stdinIsTTY?: boolean;
	sleep?: (ms: number) => Promise<void>;
	openBrowser?: (url: string) => boolean;
	lockDir?: string;
}

interface DeviceStart {
	deviceCode: string;
	deviceSecret: string;
	verificationUrl: string;
	interval: number;
	expiresIn: number;
}

interface ApprovedPoll {
	status: "approved";
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	accountId: string;
	userId: string;
}

function fail(status: number, code: string, message: string, pretty: boolean) {
	const body = JSON.stringify({ code, message }, null, pretty ? 2 : undefined);
	process.stderr.write(`${body}\n`);
	return status;
}

function writeJson(value: unknown, pretty: boolean): void {
	process.stdout.write(
		`${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`,
	);
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
	try {
		const body = (await res.json()) as unknown;
		if (body && typeof body === "object" && !Array.isArray(body)) {
			return body as Record<string, unknown>;
		}
	} catch {
		// Non-JSON bodies are transport failures at the call site.
	}
	return {};
}

function errorCode(body: Record<string, unknown>): string | undefined {
	const error = body.error;
	if (!error || typeof error !== "object") return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

async function withLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const lock = join(dir, "login.lock");
	const started = Date.now();
	for (;;) {
		try {
			await mkdir(lock);
			break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw error;
			const info = await stat(lock).catch(() => undefined);
			if (info && Date.now() - info.mtimeMs > 30_000) {
				await rmdir(lock).catch(() => undefined);
				continue;
			}
			if (Date.now() - started > 10_000) {
				throw new Error("login lock busy");
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
	try {
		return await fn();
	} finally {
		await rmdir(lock).catch(() => undefined);
	}
}

function browserOpener(): ((url: string) => boolean) | undefined {
	if (!process.stdin.isTTY) return undefined;
	const command =
		process.platform === "darwin"
			? "open"
			: process.platform === "linux"
				? "xdg-open"
				: undefined;
	if (!command) return undefined;
	return (url) => {
		const child = spawn(command, [url], {
			detached: true,
			stdio: "ignore",
		});
		child.unref();
		return true;
	};
}

async function promptPassword(): Promise<string> {
	if (!process.stdin.isTTY) {
		throw new Error("Set CADMUS_DEV_PASSWORD or run from a terminal");
	}
	process.stderr.write("Password: ");
	process.stdin.setRawMode(true);
	let line = "";
	try {
		for await (const chunk of process.stdin) {
			const text =
				typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
			let done = false;
			for (const char of text) {
				if (char === "\n" || char === "\r") {
					done = true;
					break;
				}
				if (char === "\u0003") {
					process.stderr.write("\n");
					throw new Error("password entry cancelled");
				}
				if (char === "\u007f") {
					line = line.slice(0, -1);
					continue;
				}
				line += char;
			}
			if (done) break;
		}
	} finally {
		process.stdin.setRawMode(false);
		process.stderr.write("\n");
	}
	if (!line) throw new Error("password required");
	return line;
}

export async function runLogin(io: LoginIO): Promise<number> {
	const fetchImpl = io.fetchImpl ?? fetch;
	const origin = io.origin.replace(/\/$/, "");
	const sleep = io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
	try {
		if (io.devPassword) {
			const providers = await readJson(
				await fetchImpl(`${origin}/api/auth/login/providers`),
			);
			const ids = Array.isArray(providers.providers)
				? providers.providers.flatMap((item) =>
						item &&
						typeof item === "object" &&
						typeof (item as { id?: unknown }).id === "string"
							? [(item as { id: string }).id]
							: [],
					)
				: [];
			if (!ids.includes("dev-password")) {
				return fail(
					EXIT_TRANSPORT,
					"dev_password_disabled",
					"This worker does not offer dev-password login.",
					io.pretty,
				);
			}
		}
		const started = await postJson(
			fetchImpl,
			`${origin}/api/auth/login/device/start`,
			{},
		);
		if (!started.ok) {
			return fail(
				EXIT_TRANSPORT,
				"login_failed",
				"Device login did not start.",
				io.pretty,
			);
		}
		const start = started.body as unknown as DeviceStart;
		if (
			typeof start.deviceCode !== "string" ||
			typeof start.deviceSecret !== "string" ||
			typeof start.verificationUrl !== "string"
		) {
			return fail(
				EXIT_TRANSPORT,
				"login_failed",
				"Device login did not start.",
				io.pretty,
			);
		}
		const open = io.device ? undefined : (io.openBrowser ?? browserOpener());
		if (!io.devPassword) {
			process.stderr.write(
				`Approve ${start.deviceCode}\n${start.verificationUrl}\n`,
			);
			open?.(start.verificationUrl);
		} else {
			const password =
				io.password ??
				process.env.CADMUS_DEV_PASSWORD ??
				(await promptPassword());
			const login = await postJson(
				fetchImpl,
				`${origin}/api/auth/login/devPassword`,
				{
					id: "dev-password",
					type: "auth.login.devPassword",
					payload: {
						password,
						...(io.email ? { email: io.email } : {}),
					},
				},
				{ origin },
			);
			if (!login.ok || typeof login.body.accessToken !== "string") {
				return fail(
					EXIT_TRANSPORT,
					"unauthorized",
					"Dev password login refused.",
					io.pretty,
				);
			}
			const approved = await postJson(
				fetchImpl,
				`${origin}/api/auth/login/device/approve`,
				{
					id: "device-approve",
					type: "auth.login.device.approve",
					payload: { deviceCode: start.deviceCode },
				},
				{ authorization: `Bearer ${login.body.accessToken}`, origin },
			);
			if (!approved.ok) {
				return fail(
					EXIT_TRANSPORT,
					errorCode(approved.body) ?? "unauthorized",
					"Device approval refused.",
					io.pretty,
				);
			}
		}
		const deadline =
			Date.now() +
			(typeof start.expiresIn === "number" ? start.expiresIn : 15 * 60) * 1000;
		const interval = typeof start.interval === "number" ? start.interval : 5;
		while (Date.now() <= deadline) {
			const polled = await postJson(
				fetchImpl,
				`${origin}/api/auth/login/device/poll`,
				{ deviceSecret: start.deviceSecret },
			);
			if (polled.ok && polled.body.status === "pending") {
				await sleep(interval * 1000);
				continue;
			}
			if (!polled.ok || polled.body.status !== "approved") {
				return fail(
					EXIT_TRANSPORT,
					"unauthorized",
					"Device login was denied or expired.",
					io.pretty,
				);
			}
			const session = polled.body as unknown as ApprovedPoll;
			await withLock(io.lockDir ?? join(homedir(), ".config", "cadmus"), () =>
				io.store.set(origin, session.refreshToken),
			);
			writeJson(
				{
					ok: true,
					accountId: session.accountId,
					userId: session.userId,
					expiresAt: session.expiresAt,
				},
				io.pretty,
			);
			return EXIT_OK;
		}
		return fail(
			EXIT_TRANSPORT,
			"unauthorized",
			"Device login expired.",
			io.pretty,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const status =
			message.includes("CADMUS_DEV_PASSWORD") || message.includes("password")
				? EXIT_USAGE
				: EXIT_TRANSPORT;
		return fail(
			status,
			status === EXIT_USAGE ? "usage" : "transport",
			message,
			io.pretty,
		);
	}
}

export async function runLogout(
	io: Pick<LoginIO, "origin" | "pretty" | "store" | "fetchImpl" | "lockDir">,
): Promise<number> {
	const fetchImpl = io.fetchImpl ?? fetch;
	const origin = io.origin.replace(/\/$/, "");
	try {
		const revoked = await withLock(
			io.lockDir ?? join(homedir(), ".config", "cadmus"),
			async () => {
				const refreshToken = await io.store.get(origin);
				if (!refreshToken) return false;
				const res = await postJson(
					fetchImpl,
					`${origin}/api/auth/session/logout`,
					{ refreshToken },
					{ origin, "x-cadmus-refresh": "1", "x-cadmus-cli": "1" },
				);
				await io.store.delete(origin);
				return res.ok && res.body.revoked === true;
			},
		);
		writeJson({ ok: true, revoked }, io.pretty);
		return EXIT_OK;
	} catch (error) {
		return fail(
			EXIT_TRANSPORT,
			"transport",
			error instanceof Error ? error.message : String(error),
			io.pretty,
		);
	}
}

const LOGGED_OUT = "Run cadmus auth login.";

export async function runAuthStatus(
	io: Pick<LoginIO, "origin" | "pretty" | "store" | "fetchImpl" | "lockDir"> & {
		token: string;
		account?: string;
		family?: string;
	},
): Promise<number> {
	const origin = io.origin.replace(/\/$/, "");
	let token = io.token;
	if (token.length === 0) {
		const ensured = await ensureAccessToken({
			origin,
			token: "",
			store: io.store,
			fetchImpl: io.fetchImpl,
			lockDir: io.lockDir,
		});
		if ("error" in ensured) {
			if (
				ensured.error === LOGGED_OUT ||
				ensured.error.startsWith("Refresh refused.")
			) {
				writeJson({ loggedIn: false, origin }, io.pretty);
				return EXIT_OK;
			}
			return fail(EXIT_TRANSPORT, "transport", ensured.error, io.pretty);
		}
		token = ensured.token;
	}
	try {
		const frame = await createClient(
			{ url: origin, token, account: io.account, family: io.family },
			{ fetchImpl: io.fetchImpl, useTickets: false },
		).callRpc<{ principal?: unknown }>("auth.whoami", {});
		if (!frame.ok) {
			return fail(
				EXIT_PROTOCOL,
				frame.error?.code ?? "command_failed",
				frame.error?.message ?? "auth.whoami failed",
				io.pretty,
			);
		}
		writeJson(
			{ loggedIn: true, origin, principal: frame.result?.principal ?? null },
			io.pretty,
		);
		return EXIT_OK;
	} catch (error) {
		return fail(
			EXIT_TRANSPORT,
			"transport",
			error instanceof Error ? error.message : String(error),
			io.pretty,
		);
	}
}

export async function ensureAccessToken(input: {
	origin: string;
	token: string;
	store: SecretStore;
	fetchImpl?: typeof fetch;
	lockDir?: string;
}): Promise<{ token: string } | { error: string }> {
	if (input.token.length > 0) return { token: input.token };
	const fetchImpl = input.fetchImpl ?? fetch;
	const origin = input.origin.replace(/\/$/, "");
	try {
		return await withLock(
			input.lockDir ?? join(homedir(), ".config", "cadmus"),
			async () => {
				const refreshToken = await input.store.get(origin);
				if (!refreshToken) return { error: "Run cadmus auth login." };
				const refreshed = await postJson(
					fetchImpl,
					`${origin}/api/auth/session/refresh`,
					{ refreshToken },
					{ origin, "x-cadmus-refresh": "1", "x-cadmus-cli": "1" },
				);
				if (!refreshed.ok || typeof refreshed.body.accessToken !== "string") {
					const code = errorCode(refreshed.body) ?? "unauthorized";
					const dead =
						code === "refresh_reused" ||
						code === "invalid_refresh" ||
						code === "session_expired";
					if (dead) await input.store.delete(origin);
					return {
						error: dead
							? "Run cadmus auth login."
							: "Refresh refused. Run cadmus auth login.",
					};
				}
				const next = refreshed.body.refreshToken;
				if (typeof next !== "string" || next.length === 0) {
					return { error: "Refresh did not return a new secret." };
				}
				try {
					await input.store.set(origin, next);
				} catch {
					return {
						error:
							"Could not store the rotated refresh secret. Run cadmus auth login.",
					};
				}
				return { token: refreshed.body.accessToken as string };
			},
		);
	} catch (error) {
		return {
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function postJson(
	fetchImpl: typeof fetch,
	url: string,
	body: unknown,
	headers: Record<string, string> = {},
): Promise<{ ok: boolean; body: Record<string, unknown> }> {
	const res = await fetchImpl(url, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
	return { ok: res.ok, body: await readJson(res) };
}
