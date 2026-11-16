import { randomUUID } from "node:crypto";
import { sendAccountRpc } from "../support/account.ts";
import { expect, sourceAddressFor, test } from "../support/fixtures.ts";

// Signs in on its own (or not at all); no master dev config is seeded.
test.use({ signIn: "none" });

test("token login stays budgeted per source address in the hosted stack", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? "http://127.0.0.1:8799";
	const created = await sendAccountRpc<{ token: string }>(
		origin,
		accountId,
		"auth.tokens.create",
		{
			kind: "pat",
			label: "budget",
			grants: ["chat.use", "bot.read", "tokens.self"],
			ttlDays: 1,
		},
	);
	const login = (ip?: string) =>
		page.context().request.post(`${origin}/auth/token-login`, {
			headers: {
				Authorization: `Bearer ${created.token}`,
				...(ip ? { "cf-connecting-ip": ip } : {}),
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
