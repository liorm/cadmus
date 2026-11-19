import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/edge-cache.js";
import { D1AdminStore } from "../src/store/d1-admin.js";
import {
	CLI_REFRESH_IDLE_MS,
	CLI_SESSION_ABSOLUTE_MS,
	REFRESH_IDLE_MS,
	SESSION_ABSOLUTE_MS,
} from "../src/store/d1-sessions.js";
import { uniqueAccountId } from "./helpers.js";

const ORIGIN = "http://127.0.0.1";

function store(): D1AdminStore {
	return new D1AdminStore({
		db: env.CADMUS_ADMIN_DB,
		encryptionKey: env.CADMUS_ENCRYPTION_KEY,
	});
}

async function post(
	path: string,
	body: unknown,
	headers: Record<string, string> = {},
): Promise<Response> {
	return SELF.fetch(`${ORIGIN}${path}`, {
		method: "POST",
		headers: {
			origin: ORIGIN,
			"content-type": "application/json",
			...headers,
		},
		body: JSON.stringify(body),
	});
}

async function devLogin(): Promise<string> {
	const res = await post("/api/auth/login/devPassword", {
		id: "dev",
		type: "auth.login.devPassword",
		payload: { password: "dev-pass" },
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as { accessToken: string };
	return body.accessToken;
}

async function lifetimes(accessToken: string) {
	const row = await env.CADMUS_ADMIN_DB.prepare(
		`SELECT created_at, idle_expires_at, absolute_expires_at
       FROM cadmus_sessions WHERE access_hash = ?1`,
	)
		.bind(await sha256Hex(accessToken))
		.first<{
			created_at: number;
			idle_expires_at: number;
			absolute_expires_at: number;
		}>();
	if (!row) throw new Error("session row missing");
	return {
		idle: row.idle_expires_at - row.created_at,
		absolute: row.absolute_expires_at - row.created_at,
	};
}

describe("device login", () => {
	it("mints a CLI-profile session and leaves the browser session on the web profile", async () => {
		const browser = await devLogin();
		const started = await post("/api/auth/login/device/start", {});
		expect(started.status).toBe(200);
		const start = (await started.json()) as {
			deviceCode: string;
			deviceSecret: string;
			verificationUrl: string;
		};
		expect(start.verificationUrl).toContain(
			`/login/device?code=${encodeURIComponent(start.deviceCode)}`,
		);
		expect(start.verificationUrl).not.toContain(start.deviceSecret);
		const pending = await post("/api/auth/login/device/poll", {
			deviceSecret: start.deviceSecret,
		});
		expect(await pending.json()).toEqual({ status: "pending" });
		const approved = await post(
			"/api/auth/login/device/approve",
			{ payload: { deviceCode: start.deviceCode } },
			{ authorization: `Bearer ${browser}` },
		);
		expect(approved.status).toBe(200);
		expect(await approved.json()).toEqual({ approved: true });
		const polled = await post("/api/auth/login/device/poll", {
			deviceSecret: start.deviceSecret,
		});
		expect(polled.status).toBe(200);
		const session = (await polled.json()) as {
			refreshToken: string;
			accessToken: string;
		};
		expect(session.refreshToken.startsWith("cad_rt_")).toBe(true);
		expect(await lifetimes(browser)).toEqual({
			idle: REFRESH_IDLE_MS,
			absolute: SESSION_ABSOLUTE_MS,
		});
		expect(await lifetimes(session.accessToken)).toEqual({
			idle: CLI_REFRESH_IDLE_MS,
			absolute: CLI_SESSION_ABSOLUTE_MS,
		});
		const again = await post("/api/auth/login/device/poll", {
			deviceSecret: start.deviceSecret,
		});
		expect(again.status).toBe(401);
		const byCode = await post("/api/auth/login/device/poll", {
			deviceSecret: start.deviceCode,
		});
		expect(byCode.status).toBe(401);
	});

	it("refuses to approve a provisional session", async () => {
		const s = store();
		const accountId = uniqueAccountId("device");
		const userId = `usr_${accountId}`;
		await s.ensureAccountAndUser({ accountId, userId, role: "user" });
		await s.ensureAccountAndUser({
			accountId,
			userId,
			role: "account-admin",
		});
		const provisional = await s.createSession({
			userId,
			accountId,
			provisional: true,
		});
		const started = await s.startDeviceLogin();
		const res = await post(
			"/api/auth/login/device/approve",
			{ payload: { deviceCode: started.deviceCode } },
			{ authorization: `Bearer ${provisional.accessToken}` },
		);
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
			"provisional_session",
		);
	});

	it("denies a grant and rotates a CLI refresh secret once", async () => {
		const browser = await devLogin();
		const start = (await (
			await post("/api/auth/login/device/start", {})
		).json()) as { deviceCode: string; deviceSecret: string };
		const denied = await post(
			"/api/auth/login/device/deny",
			{ deviceCode: start.deviceCode },
			{ authorization: `Bearer ${browser}` },
		);
		expect(denied.status).toBe(200);
		expect(
			(
				await post("/api/auth/login/device/poll", {
					deviceSecret: start.deviceSecret,
				})
			).status,
		).toBe(401);

		const next = (await (
			await post("/api/auth/login/device/start", {})
		).json()) as { deviceCode: string; deviceSecret: string };
		expect(
			(
				await post(
					"/api/auth/login/device/approve",
					{ deviceCode: next.deviceCode },
					{ authorization: `Bearer ${browser}` },
				)
			).status,
		).toBe(200);
		const session = (await (
			await post("/api/auth/login/device/poll", {
				deviceSecret: next.deviceSecret,
			})
		).json()) as { refreshToken: string };
		const refreshed = await post(
			"/api/auth/session/refresh",
			{ refreshToken: session.refreshToken },
			{ "x-cadmus-refresh": "1", "x-cadmus-cli": "1" },
		);
		expect(refreshed.status).toBe(200);
		const body = (await refreshed.json()) as { refreshToken?: string };
		expect(body.refreshToken?.startsWith("cad_rt_")).toBe(true);
		expect(body.refreshToken).not.toBe(session.refreshToken);
		const replay = await post(
			"/api/auth/session/refresh",
			{ refreshToken: session.refreshToken },
			{ "x-cadmus-refresh": "1", "x-cadmus-cli": "1" },
		);
		expect(replay.status).toBe(401);
		expect(
			((await replay.json()) as { error: { code: string } }).error.code,
		).toBe("refresh_reused");

		const cookie =
			(
				await post("/api/auth/login/devPassword", {
					payload: { password: "dev-pass" },
				})
			).headers.get("set-cookie") ?? "";
		const browserRefresh = await SELF.fetch(
			`${ORIGIN}/api/auth/session/refresh`,
			{
				method: "POST",
				headers: {
					origin: ORIGIN,
					"x-cadmus-refresh": "1",
					"sec-fetch-site": "same-origin",
					"x-cadmus-cli": "1",
					cookie: cookie.split(";")[0] ?? "",
				},
			},
		);
		expect(browserRefresh.status).toBe(200);
		const browserBody = (await browserRefresh.json()) as {
			refreshToken?: string;
		};
		expect(browserBody.refreshToken).toBeUndefined();
	});

	it("stores the CLI label and country, and lists that session first for itself", async () => {
		const browser = await devLogin();
		const started = await post(
			"/api/auth/login/device/start",
			{},
			{
				"x-cadmus-cli": "1",
				"user-agent": "cadmus-cli/0.1.0 (darwin arm64; test-host)",
				"cf-ipcountry": "IL",
			},
		);
		const start = (await started.json()) as {
			deviceCode: string;
			deviceSecret: string;
		};
		expect(
			(
				await post(
					"/api/auth/login/device/approve",
					{ payload: { deviceCode: start.deviceCode } },
					{ authorization: `Bearer ${browser}` },
				)
			).status,
		).toBe(200);
		const polled = await post("/api/auth/login/device/poll", {
			deviceSecret: start.deviceSecret,
		});
		const session = (await polled.json()) as { accessToken: string };
		const listed = await SELF.fetch(`${ORIGIN}/api/auth/sessions/list`, {
			headers: {
				authorization: `Bearer ${session.accessToken}`,
				origin: ORIGIN,
			},
		});
		expect(listed.status).toBe(200);
		const body = (await listed.json()) as {
			sessions: Array<{
				current: boolean;
				client?: string;
				userAgent?: string;
				ipCountry?: string;
			}>;
		};
		expect(body.sessions[0]).toMatchObject({
			current: true,
			client: "cli",
			userAgent: "cadmus-cli/0.1.0 (darwin arm64; test-host)",
			ipCountry: "IL",
		});
		expect(body.sessions.some((row) => row.client === "web")).toBe(true);
	});
});
