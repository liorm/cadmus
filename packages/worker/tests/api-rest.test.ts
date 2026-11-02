import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { type Logger, setupLogger } from "../src/log.js";
import { TEST_TOKEN, uniqueAccountId } from "./helpers.js";

describe("REST /api logging redaction", () => {
	it("rejects query tokens on /api without logging the token value", async () => {
		const accountId = uniqueAccountId("api-qtoken");
		const queryAccountId = uniqueAccountId("api-query");
		const querySecret = `qtok-${crypto.randomUUID()}`;
		const headers = {
			Authorization: `Bearer ${TEST_TOKEN}`,
			"x-account-id": accountId,
		};
		const captured: {
			level: string;
			message: string;
			fields?: Record<string, unknown>;
		}[] = [];
		const makeCustom = (bound: Record<string, unknown> = {}): Logger => ({
			debug: (message, fields) =>
				captured.push({
					level: "debug",
					message,
					fields: { ...bound, ...fields },
				}),
			info: (message, fields) =>
				captured.push({
					level: "info",
					message,
					fields: { ...bound, ...fields },
				}),
			warn: (message, fields) =>
				captured.push({
					level: "warn",
					message,
					fields: { ...bound, ...fields },
				}),
			error: (message, fields) =>
				captured.push({
					level: "error",
					message,
					fields: { ...bound, ...fields },
				}),
			child: (fields) => makeCustom({ ...bound, ...fields }),
		});

		try {
			setupLogger({ type: "custom", logger: makeCustom() });
			const r1 = await SELF.fetch(
				`http://example.com/api/bot/list?token=${encodeURIComponent(querySecret)}&accountId=${encodeURIComponent(queryAccountId)}`,
			);
			expect(r1.status).toBe(401);
			const r2 = await SELF.fetch(
				`http://example.com/api/bot/list?token=${encodeURIComponent(querySecret)}`,
				{ headers },
			);
			expect(r2.status).toBe(401);

			const logged = JSON.stringify(captured);
			expect(logged).toContain("query_token_not_allowed");
			expect(logged).toContain("/api/bot/list");
			expect(logged).not.toContain(querySecret);
		} finally {
			setupLogger({ type: "silent" });
		}
	});
});
