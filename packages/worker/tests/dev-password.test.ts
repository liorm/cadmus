import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { devPasswordState } from "../src/auth/dev-password.js";

function login(host: string, body: Record<string, unknown>, origin = host) {
	return SELF.fetch(`${host}/api/auth/login/devPassword`, {
		method: "POST",
		headers: { origin, "content-type": "application/json" },
		body: JSON.stringify({
			id: "dev",
			type: "auth.login.devPassword",
			payload: body,
		}),
	});
}

describe("dev password login (issue #3 phase 5)", () => {
	it("works on localhost for the bootstrap super-admin", async () => {
		const res = await login("http://localhost", { password: "dev-pass" });
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(res.headers.get("set-cookie") ?? "").toContain("cadmus_refresh=");
		const body = (await res.json()) as { accessToken: string };
		expect(body.accessToken.startsWith("cad_at_")).toBe(true);
	});

	it("rejects a wrong password and a missing origin", async () => {
		expect(
			(
				await login("http://localhost", {
					email: `wrong-${crypto.randomUUID()}@example.com`,
					password: "nope",
				})
			).status,
		).toBe(401);
		expect(
			(
				await login(
					"http://localhost",
					{ password: "dev-pass" },
					"http://evil.test",
				)
			).status,
		).toBe(403);
	});

	it("refuses loudly on a non-local host even with the right password", async () => {
		const res = await login("https://example.com", { password: "dev-pass" });
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("dev_password_unsafe_environment");
	});

	it("is not offered as a provider off localhost", async () => {
		const remote = await SELF.fetch(
			"https://example.com/api/auth/login/providers",
		);
		const ids = ((await remote.json()) as { providers: { id: string }[] })
			.providers;
		expect(ids.map((p) => p.id)).not.toContain("dev-password");
		const local = await SELF.fetch("http://localhost/api/auth/login/providers");
		const localIds = ((await local.json()) as { providers: { id: string }[] })
			.providers;
		expect(localIds.map((p) => p.id)).toContain("dev-password");
	});

	it("guard refuses previews and production and stays off when unset", () => {
		const url = new URL("http://localhost/");
		const on = {
			CADMUS_DEV_PASSWORD_LOGIN: "1",
			CADMUS_DEV_PASSWORD_HASH: "pbkdf2-sha256$1$AA$AA",
		};
		expect(devPasswordState(on, url).state).toBe("on");
		expect(devPasswordState({ ...on, IS_PREVIEW: "true" }, url)).toEqual({
			state: "refused",
			reason: "preview",
		});
		expect(
			devPasswordState({ ...on, CADMUS_DEPLOY_ENV: "production" }, url),
		).toEqual({
			state: "refused",
			reason: "production",
		});
		// Issue #3 names CADMUS_ENV: honored too, as a string only.
		for (const value of ["production", " Production "]) {
			expect(devPasswordState({ ...on, CADMUS_ENV: value }, url)).toEqual({
				state: "refused",
				reason: "production",
			});
			expect(
				devPasswordState({ ...on, CADMUS_DEPLOY_ENV: value }, url),
			).toEqual({ state: "refused", reason: "production" });
		}
		// Positive controls: other strings and the DO binding object do not refuse.
		expect(
			devPasswordState({ ...on, CADMUS_ENV: "development" }, url).state,
		).toBe("on");
		expect(
			devPasswordState({ ...on, CADMUS_ENV: { getByName() {} } }, url).state,
		).toBe("on");
		expect(
			devPasswordState(on, new URL("https://cadmus.example.com/")).state,
		).toBe("refused");
		expect(devPasswordState({}, url).state).toBe("off");
		expect(
			devPasswordState({ CADMUS_DEV_PASSWORD_LOGIN: "1" }, url).state,
		).toBe("off");
	});
});
