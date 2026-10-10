// Grok via subscription OAuth: `bun run login grok` as a real process, then the bot using and refreshing the token.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { App } from "../../src/app.ts";
import { FileCredentialStore } from "../../src/harness/credentials.ts";
import { FakeEgress } from "../egress/fake-egress.ts";
import { routeEgress } from "../egress/route.ts";
import {
	botEnv,
	defined,
	settle,
	spawnBun,
	startBot,
	tempHome,
	until,
} from "../support.ts";

let egress: FakeEgress;
let unroute: () => void;
let apps: App[] = [];
beforeEach(() => {
	egress = new FakeEgress();
	unroute = routeEgress(egress.url);
});
afterEach(async () => {
	for (const app of apps) await app.stop();
	apps = [];
	unroute();
	egress.stop();
});

const scriptEnv = (home: string) => botEnv(home, { XAI_API_KEY: undefined });

async function login(home: string) {
	const child = spawnBun(
		["scripts/auth.ts", "login", "grok"],
		scriptEnv(home),
		egress,
	);
	expect(await child.exited).toBe(0);
	return child.output();
}

describe("Grok subscription login (OAuth device code)", () => {
	it("bun run login grok prints the device URL + code, waits for approval, and stores a 0600 token", async () => {
		const home = await tempHome();
		const output = await login(home);
		expect(output).toContain(
			"https://accounts.x.ai/device?user_code=WXYZ-1234",
		);
		expect(output).toContain("WXYZ-1234");
		expect(output).toContain("Logged in: xai");
		const [device, pending, approved] = egress.xai.oauthRequests;
		expect(defined(device, "device").path).toBe("/oauth2/device/code");
		expect(defined(device, "device").form.get("scope")).toContain(
			"offline_access",
		);
		expect(defined(pending, "pending").form.get("grant_type")).toBe(
			"urn:ietf:params:oauth:grant-type:device_code",
		);
		expect(approved).toBeDefined();
		const authFile = join(home, "auth.json");
		expect((await stat(authFile)).mode & 0o777).toBe(0o600);
		expect(JSON.parse(await readFile(authFile, "utf8")).xai).toMatchObject({
			type: "oauth",
			access: "xai-access-1",
		});

		const status = spawnBun(
			["scripts/auth.ts", "status"],
			scriptEnv(home),
			egress,
		);
		expect(await status.exited).toBe(0);
		expect(status.output()).toContain("xai: oauth — ok (OAuth)");

		const logout = spawnBun(
			["scripts/auth.ts", "logout", "grok"],
			scriptEnv(home),
			egress,
		);
		expect(await logout.exited).toBe(0);
		expect(await FileCredentialStore.inHome(home).read("xai")).toBeUndefined();
	}, 30_000);

	it("the bot talks to Grok with the subscription token, without XAI_API_KEY", async () => {
		const home = await tempHome();
		await login(home);
		const app = await startBot(home, { XAI_API_KEY: undefined });
		apps.push(app);
		egress.telegram.push("hi grok");
		await until(() => egress.telegram.sent.length === 1, "reply");
		await settle(app, egress);
		expect(egress.telegram.texts()).toEqual(["grok(1): hi grok"]);
		expect(defined(egress.xai.requests[0], "request").authorization).toBe(
			"Bearer xai-access-1",
		);
	}, 30_000);

	it("an expiring token is refreshed via auth.x.ai, rotated in auth.json, and used", async () => {
		const home = await tempHome();
		await login(home);
		const store = FileCredentialStore.inHome(home);
		await store.modify(
			"xai",
			async (current) =>
				({
					...defined(current, "credential"),
					expires: Date.now() + 1000,
				}) as never,
		);
		const app = await startBot(home, { XAI_API_KEY: undefined });
		apps.push(app);
		egress.telegram.push("after refresh");
		await until(() => egress.telegram.sent.length === 1, "reply");
		await settle(app, egress);
		const refresh = egress.xai.oauthRequests.find(
			(request) => request.form.get("grant_type") === "refresh_token",
		);
		expect(defined(refresh, "refresh").form.get("refresh_token")).toBe(
			"xai-refresh-1",
		);
		expect(await store.read("xai")).toMatchObject({
			access: "xai-access-2",
			refresh: "xai-refresh-2",
		});
		expect(defined(egress.xai.requests[0], "request").authorization).toBe(
			"Bearer xai-access-2",
		);
	}, 30_000);

	it("a dead refresh token stops startup with the login command", async () => {
		const home = await tempHome();
		await FileCredentialStore.inHome(home).modify("xai", async () => ({
			type: "oauth",
			access: "old",
			refresh: "revoked",
			expires: Date.now() - 1,
		}));
		await expect(startBot(home, { XAI_API_KEY: undefined })).rejects.toThrow(
			/bun run login xai/,
		);
	});

	it("auth.json writes from concurrent processes never lose an update (bot refresh vs. login)", async () => {
		const home = await tempHome();
		const a = FileCredentialStore.inHome(home);
		const b = FileCredentialStore.inHome(home);
		const bump = (store: FileCredentialStore) =>
			store.modify("counter", async (current) => ({
				type: "api_key",
				key: String(Number((current as { key?: string })?.key ?? 0) + 1),
			}));
		await Promise.all(
			Array.from({ length: 20 }, (_, i) => bump(i % 2 ? a : b)),
		);
		expect(await a.read("counter")).toEqual({ type: "api_key", key: "20" });
	});
});
