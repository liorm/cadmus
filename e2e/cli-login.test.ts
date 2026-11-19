import { describe, expect, it } from "vitest";
import { loginDevPassword, useWorkerFixture, workerFetch } from "./helpers.js";

const ORIGIN = "http://127.0.0.1";

async function post(
	path: string,
	body: unknown,
	headers: Record<string, string> = {},
): Promise<Response> {
	return workerFetch(`${ORIGIN}${path}`, {
		method: "POST",
		headers: {
			origin: ORIGIN,
			"content-type": "application/json",
			...headers,
		},
		body: JSON.stringify(body),
	});
}

describe("cli device login", () => {
	useWorkerFixture();

	it("returns cad_rt_ only from the poll and rotates it", async () => {
		const browser = await loginDevPassword();
		const started = await post("/api/auth/login/device/start", {});
		expect(started.status).toBe(200);
		const start = (await started.json()) as {
			deviceCode: string;
			deviceSecret: string;
		};
		expect(JSON.stringify(start)).not.toContain("cad_rt_");
		const approved = await post(
			"/api/auth/login/device/approve",
			{
				id: "device-approve",
				type: "auth.login.device.approve",
				payload: { deviceCode: start.deviceCode },
			},
			{ authorization: `Bearer ${browser.accessToken}` },
		);
		expect(approved.status).toBe(200);
		const approveBody = (await approved.json()) as { refreshToken?: string };
		expect(approveBody.refreshToken).toBeUndefined();
		const polled = await post("/api/auth/login/device/poll", {
			deviceSecret: start.deviceSecret,
		});
		expect(polled.status).toBe(200);
		const session = (await polled.json()) as {
			status: string;
			refreshToken: string;
			accessToken: string;
		};
		expect(session.status).toBe("approved");
		expect(session.refreshToken.startsWith("cad_rt_")).toBe(true);
		expect(session.accessToken.startsWith("cad_at_")).toBe(true);
		const refreshed = await post(
			"/api/auth/session/refresh",
			{ refreshToken: session.refreshToken },
			{ "x-cadmus-refresh": "1", "x-cadmus-cli": "1" },
		);
		expect(refreshed.status).toBe(200);
		const rotated = (await refreshed.json()) as { refreshToken: string };
		expect(rotated.refreshToken.startsWith("cad_rt_")).toBe(true);
		expect(rotated.refreshToken).not.toBe(session.refreshToken);
		const replay = await post(
			"/api/auth/session/refresh",
			{ refreshToken: session.refreshToken },
			{ "x-cadmus-refresh": "1", "x-cadmus-cli": "1" },
		);
		expect(replay.status).toBe(401);
		expect(
			((await replay.json()) as { error: { code: string } }).error.code,
		).toBe("refresh_reused");
	});
});
