import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgv } from "../src/argv.js";
import {
	ensureAccessToken,
	runAuthStatus,
	runLogin,
	runLogout,
} from "../src/login.js";
import {
	createFileSecretStore,
	createMemorySecretStore,
} from "../src/secret-store.js";

const ORIGIN = "http://127.0.0.1:8787";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

async function capture(
	fn: () => Promise<number>,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const out = process.stdout.write;
	const err = process.stderr.write;
	process.stdout.write = ((chunk: string | Uint8Array) => {
		stdout.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderr.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	try {
		const code = await fn();
		return { code, stdout: stdout.join(""), stderr: stderr.join("") };
	} finally {
		process.stdout.write = out;
		process.stderr.write = err;
	}
}

describe("cli login", () => {
	it("parses login flags", () => {
		const parsed = parseArgv(["auth", "login", "--dev-password", "--device"]);
		expect(parsed.command).toBe("auth");
		expect(parsed.positionals).toEqual(["login"]);
		expect(parsed.devPassword).toBe(true);
		expect(parsed.device).toBe(true);
	});

	it("stores only the refresh secret from a dev-password device login", async () => {
		const store = createMemorySecretStore();
		const dir = await mkdtemp(join(tmpdir(), "cadmus-login-"));
		const calls: string[] = [];
		const fetchImpl = (async (url: string) => {
			calls.push(String(url));
			if (String(url).endsWith("/providers")) {
				return json({ providers: [{ id: "dev-password" }] });
			}
			if (String(url).endsWith("/device/start")) {
				return json({
					deviceCode: "ABCD-EFGH",
					deviceSecret: "cad_ds_secret",
					verificationUrl: `${ORIGIN}/login/device?code=ABCD-EFGH`,
					interval: 5,
					expiresIn: 60,
				});
			}
			if (String(url).endsWith("/devPassword")) {
				return json({ accessToken: "cad_at_browser", expiresAt: 1 });
			}
			if (String(url).endsWith("/device/approve")) {
				return json({ approved: true });
			}
			return json({
				status: "approved",
				accessToken: "cad_at_cli",
				refreshToken: "cad_rt_cli",
				expiresAt: 99,
				accountId: "acct",
				userId: "usr",
			});
		}) as typeof fetch;
		const result = await capture(() =>
			runLogin({
				origin: ORIGIN,
				pretty: false,
				store,
				fetchImpl,
				device: true,
				devPassword: true,
				password: "dev-pass",
				lockDir: dir,
				sleep: async () => {},
			}),
		);
		expect(result.code).toBe(0);
		expect(result.stdout).not.toContain("cad_rt_");
		expect(result.stdout).not.toContain("cad_at_");
		expect(JSON.parse(result.stdout)).toMatchObject({
			ok: true,
			accountId: "acct",
			userId: "usr",
		});
		expect(await store.get(ORIGIN)).toBe("cad_rt_cli");
		expect(calls.some((url) => url.endsWith("/devPassword"))).toBe(true);
	});

	it("refreshes the stored secret and sends the new access token", async () => {
		const store = createMemorySecretStore();
		await store.set(ORIGIN, "cad_rt_old");
		const dir = await mkdtemp(join(tmpdir(), "cadmus-refresh-"));
		let seen = "";
		const fetchImpl = (async (_url: string, init?: RequestInit) => {
			seen = String(init?.body ?? "");
			return json({
				accessToken: "cad_at_new",
				refreshToken: "cad_rt_new",
				expiresAt: 5,
			});
		}) as typeof fetch;
		const ensured = await ensureAccessToken({
			origin: ORIGIN,
			token: "",
			store,
			fetchImpl,
			lockDir: dir,
		});
		expect(ensured).toEqual({ token: "cad_at_new" });
		expect(seen).toContain("cad_rt_old");
		expect(await store.get(ORIGIN)).toBe("cad_rt_new");
	});

	it("does not touch the store when --token is set", async () => {
		const store = createMemorySecretStore();
		const fetchImpl = (() => {
			throw new Error("fetch");
		}) as unknown as typeof fetch;
		const ensured = await ensureAccessToken({
			origin: ORIGIN,
			token: "cad_at_explicit",
			store,
			fetchImpl,
		});
		expect(ensured).toEqual({ token: "cad_at_explicit" });
		expect(await store.get(ORIGIN)).toBeUndefined();
	});

	it("deletes the stored secret when the refresh secret was reused", async () => {
		const store = createMemorySecretStore();
		await store.set(ORIGIN, "cad_rt_old");
		const dir = await mkdtemp(join(tmpdir(), "cadmus-reused-"));
		const ensured = await ensureAccessToken({
			origin: ORIGIN,
			token: "",
			store,
			fetchImpl: (async () =>
				json(
					{ error: { code: "refresh_reused", message: "Refresh refused" } },
					401,
				)) as unknown as typeof fetch,
			lockDir: dir,
		});
		expect("error" in ensured && ensured.error).toBe("Run cadmus auth login.");
		expect(await store.get(ORIGIN)).toBeUndefined();
	});

	it("does not continue when the rotated secret cannot be stored", async () => {
		const store = createMemorySecretStore();
		await store.set(ORIGIN, "cad_rt_old");
		store.set = async () => {
			throw new Error("disk full");
		};
		const dir = await mkdtemp(join(tmpdir(), "cadmus-persist-"));
		const ensured = await ensureAccessToken({
			origin: ORIGIN,
			token: "",
			store,
			fetchImpl: (async () =>
				json({
					accessToken: "cad_at_new",
					refreshToken: "cad_rt_new",
					expiresAt: 5,
				})) as unknown as typeof fetch,
			lockDir: dir,
		});
		expect("error" in ensured).toBe(true);
	});

	it("deletes the secret on logout", async () => {
		const store = createMemorySecretStore();
		await store.set(ORIGIN, "cad_rt_cli");
		const dir = await mkdtemp(join(tmpdir(), "cadmus-logout-"));
		const result = await capture(() =>
			runLogout({
				origin: ORIGIN,
				pretty: false,
				store,
				lockDir: dir,
				fetchImpl: (async () =>
					json({ revoked: true })) as unknown as typeof fetch,
			}),
		);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({ ok: true, revoked: true });
		expect(await store.get(ORIGIN)).toBeUndefined();
	});

	it("reports logged out when no refresh secret is stored", async () => {
		const store = createMemorySecretStore();
		const result = await capture(() =>
			runAuthStatus({
				origin: ORIGIN,
				pretty: false,
				store,
				token: "",
				fetchImpl: (async () => {
					throw new Error("should not call the worker");
				}) as unknown as typeof fetch,
			}),
		);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			loggedIn: false,
			origin: ORIGIN,
		});
	});

	it("prints the auth.whoami principal when a session refreshes", async () => {
		const store = createMemorySecretStore();
		await store.set(ORIGIN, "cad_rt_old");
		const dir = await mkdtemp(join(tmpdir(), "cadmus-status-"));
		const principal = {
			kind: "user",
			userId: "usr_1",
			name: "Ada",
			accountId: "acct_1",
			role: "user",
		};
		const result = await capture(() =>
			runAuthStatus({
				origin: ORIGIN,
				pretty: false,
				store,
				token: "",
				lockDir: dir,
				fetchImpl: (async (url: string) => {
					if (String(url).endsWith("/api/auth/session/refresh")) {
						return json({
							accessToken: "cad_at_new",
							refreshToken: "cad_rt_new",
							expiresAt: 5,
						});
					}
					return json({ principal });
				}) as unknown as typeof fetch,
			}),
		);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			loggedIn: true,
			origin: ORIGIN,
			principal,
		});
		expect(await store.get(ORIGIN)).toBe("cad_rt_new");
	});

	it("writes the file fallback as mode 0600", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cadmus-file-"));
		const path = join(dir, "credentials.json");
		const store = createFileSecretStore(path);
		await store.set(ORIGIN, "cad_rt_file");
		expect(await store.get(ORIGIN)).toBe("cad_rt_file");
		const { stat } = await import("node:fs/promises");
		expect((await stat(path)).mode & 0o777).toBe(0o600);
	});
});
