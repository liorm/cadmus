import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("wrangler.jsonc dev password guard", () => {
	const text = readFileSync(
		new URL("../../wrangler.jsonc", import.meta.url),
		"utf8",
	);

	test("never sets CADMUS_DEV_PASSWORD_*", () => {
		expect(text).not.toContain("CADMUS_DEV_PASSWORD");
	});

	test("marks the top-level (production) vars as production", () => {
		expect(text).toContain('"CADMUS_DEPLOY_ENV": "production"');
		// Previews must not claim production, but IS_PREVIEW refuses them.
		expect(text).toContain('"IS_PREVIEW": "true"');
	});
});
