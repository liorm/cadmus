import { randomUUID } from "node:crypto";
import { BOOTSTRAP_EMAIL, DEV_PASSWORD } from "../support/dev-session.ts";
import { expect, sourceAddressFor, test } from "../support/fixtures.ts";

// Signs in on its own (or not at all); no master dev config is seeded.
test.use({ signIn: "none" });

test("dev-password login stays budgeted per source address in the hosted stack", async ({
	page,
	baseURL,
}) => {
	const origin = baseURL ?? "http://127.0.0.1:8799";
	const url = new URL(origin);
	const login = (ip?: string) =>
		page.context().request.post(`${origin}/api/auth/login/devPassword`, {
			headers: {
				Origin: url.origin,
				"Content-Type": "application/json",
				...(ip ? { "cf-connecting-ip": ip } : {}),
			},
			data: {
				id: "dev-password",
				type: "auth.login.devPassword",
				payload: { email: BOOTSTRAP_EMAIL, password: DEV_PASSWORD },
			},
		});
	// Fresh addresses every attempt (retry or rerun inside the 60 s window would
	// otherwise start with a spent budget).
	const nonce = randomUUID();
	const addrA = sourceAddressFor(`${nonce}:a`, 0);
	const addrB = sourceAddressFor(`${nonce}:b`, 0);
	const statuses: number[] = [];
	for (let i = 0; i < 21; i++) statuses.push((await login(addrA)).status());
	expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
	const refused = await login(addrA);
	expect(statuses[20]).toBe(429);
	expect(Number(refused.headers()["retry-after"])).toBeGreaterThan(0);
	expect((await refused.json()).error.code).toBe("rate_limited");
	// A different source address has its own budget.
	expect((await login(addrB)).status()).toBe(200);
});
