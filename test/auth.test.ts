// OAuth credentials (xAI / Grok subscription) with mocked xAI endpoints: no network, no real account.
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { AuthPrompt, Credential } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { FileCredentialStore } from "../src/harness/credentials.ts";
import { loginProvider, resolveProviderId } from "../src/harness/login.ts";
import { checkModel, createModels } from "../src/harness/models.ts";
import { tempHome } from "./support.ts";

const realFetch = globalThis.fetch;
const savedKey = process.env.XAI_API_KEY;
type Call = { url: string; body: string; headers: Headers };
let calls: Call[] = [];

function mockFetch(handler: (call: Call) => Response | Promise<Response>) {
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const request = input instanceof Request ? input : new Request(input.toString(), init);
		const call = { url: request.url, body: await request.text(), headers: request.headers };
		calls.push(call);
		return handler(call);
	}) as typeof fetch;
}
const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
	calls = [];
	delete process.env.XAI_API_KEY;
});
afterEach(() => {
	globalThis.fetch = realFetch;
	if (savedKey === undefined) delete process.env.XAI_API_KEY;
	else process.env.XAI_API_KEY = savedKey;
});

const oauth = (access: string, expiresInMs: number, refresh = "refresh-1"): Credential => ({
	type: "oauth",
	access,
	refresh,
	expires: Date.now() + expiresInMs,
});

describe("FileCredentialStore (data/auth.json)", () => {
	it("persists across instances with mode 0600, lists types only, deletes", async () => {
		const home = await tempHome();
		const store = FileCredentialStore.inHome(home);
		await store.modify("xai", async () => oauth("a1", 3_600_000));
		expect((await stat(join(home, "auth.json"))).mode & 0o777).toBe(0o600);
		const other = FileCredentialStore.inHome(home);
		expect(await other.read("xai")).toMatchObject({ type: "oauth", access: "a1" });
		expect(await other.list()).toEqual([{ providerId: "xai", type: "oauth" }]);
		await other.delete("xai");
		expect(await store.read("xai")).toBeUndefined();
	});

	it("serializes read-modify-write across store instances (bot refresh vs. login script)", async () => {
		const home = await tempHome();
		const a = FileCredentialStore.inHome(home);
		const b = FileCredentialStore.inHome(home);
		const bump = (store: FileCredentialStore) =>
			store.modify("counter", async (current) => ({ type: "api_key", key: String(Number((current as { key?: string })?.key ?? 0) + 1) }));
		await Promise.all(Array.from({ length: 20 }, (_, i) => bump(i % 2 ? a : b)));
		expect(await a.read("counter")).toEqual({ type: "api_key", key: "20" });
	});
});

describe("xAI subscription OAuth via pi-ai", () => {
	it("maps grok aliases to the xai provider", () => {
		expect(resolveProviderId("grok")).toBe("xai");
		expect(resolveProviderId("XAI")).toBe("xai");
	});

	it("uses a stored OAuth token instead of XAI_API_KEY, and checkModel accepts it", async () => {
		const store = FileCredentialStore.inHome(await tempHome());
		await store.modify("xai", async () => oauth("access-ok", 3_600_000));
		const models = createModels(undefined, { credentials: store });
		const auth = await models.getAuth("xai");
		expect(auth).toMatchObject({ auth: { apiKey: "access-ok" }, source: "OAuth" });
		expect(await checkModel(models, { provider: "xai", modelId: "grok-4.7" })).toBe("OAuth");
		expect(calls).toEqual([]); // valid token: no network
	});

	it("refreshes an expiring token through auth.x.ai and stores the rotated credential", async () => {
		const store = FileCredentialStore.inHome(await tempHome());
		await store.modify("xai", async () => oauth("access-old", 60_000, "refresh-old")); // inside the refresh skew
		mockFetch(() => json(200, { access_token: "access-new", refresh_token: "refresh-new", expires_in: 3600 }));
		const models = createModels(undefined, { credentials: store });
		expect((await models.getAuth("xai"))?.auth.apiKey).toBe("access-new");
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe("https://auth.x.ai/oauth2/token");
		const form = new URLSearchParams(calls[0]!.body);
		expect(form.get("grant_type")).toBe("refresh_token");
		expect(form.get("refresh_token")).toBe("refresh-old");
		expect(await store.read("xai")).toMatchObject({ access: "access-new", refresh: "refresh-new" });
	});

	it("reports a failed refresh with the login command", async () => {
		const store = FileCredentialStore.inHome(await tempHome());
		await store.modify("xai", async () => oauth("access-old", -1000));
		mockFetch(() => json(400, { error: "invalid_grant" }));
		const models = createModels(undefined, { credentials: store });
		await expect(checkModel(models, { provider: "xai", modelId: "grok-4.7" })).rejects.toThrow(/bun run login xai/);
	});

	it("without a token or key, tells the user to log in", async () => {
		const models = createModels(undefined, { credentials: FileCredentialStore.inHome(await tempHome()) });
		await expect(checkModel(models, { provider: "xai", modelId: "grok-4.7" })).rejects.toThrow(/XAI_API_KEY.*bun run login xai/);
	});

	it("device-code login: prints URL + code, polls until approved, stores the token", async () => {
		const home = await tempHome();
		const store = FileCredentialStore.inHome(home);
		let polls = 0;
		mockFetch((call) => {
			if (call.url === "https://auth.x.ai/oauth2/device/code")
				return json(200, {
					device_code: "dev-123",
					user_code: "ABCD-EFGH",
					verification_uri: "https://accounts.x.ai/device",
					verification_uri_complete: "https://accounts.x.ai/device?user_code=ABCD-EFGH",
					expires_in: 600,
					interval: 1,
				});
			polls++;
			return polls === 1
				? json(400, { error: "authorization_pending" })
				: json(200, { access_token: "access-login", refresh_token: "refresh-login", expires_in: 3600 });
		});
		const printed: string[] = [];
		const models = createModels(undefined, { credentials: store });
		await loginProvider(models, "xai", {
			print: (text) => printed.push(text),
			ask: async (prompt: AuthPrompt) => {
				throw new Error(`unexpected prompt ${prompt.type}`);
			},
		});
		expect(printed.join("\n")).toContain("https://accounts.x.ai/device?user_code=ABCD-EFGH");
		expect(printed.join("\n")).toContain("ABCD-EFGH");
		const device = new URLSearchParams(calls[0]!.body);
		expect(device.get("scope")).toContain("offline_access");
		expect(new URLSearchParams(calls.at(-1)!.body).get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
		expect(await FileCredentialStore.inHome(home).read("xai")).toMatchObject({ type: "oauth", access: "access-login" });
	}, 20_000);

	it("sends the OAuth token as the bearer on Grok requests to api.x.ai", async () => {
		const store = FileCredentialStore.inHome(await tempHome());
		await store.modify("xai", async () => oauth("access-bearer", 3_600_000));
		mockFetch(() => json(401, { error: { message: "mock: stop here" } }));
		const models = createModels(undefined, { credentials: store });
		const model = models.getModel("xai", "grok-4.7")!;
		const message = await models.completeSimple(model, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] });
		expect(message.stopReason).toBe("error");
		const request = calls.find((call) => call.url.startsWith("https://api.x.ai/"));
		expect(request?.headers.get("authorization")).toBe("Bearer access-bearer");
	});
});
