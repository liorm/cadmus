import { describe, expect, it } from "vitest";
import {
	type AccountCredentialsTestResult,
	adminScope,
	callApi,
	useWorkerFixture,
} from "./helpers.js";

describe("account.credentials.test", () => {
	useWorkerFixture();

	it("returns ok: true when testing the offline faux provider", async () => {
		const scope = await adminScope("default");
		const res = await callApi<AccountCredentialsTestResult>(
			"account.credentials.test",
			{ providerId: "faux" },
			scope,
		);
		expect(res.ok).toBe(true);
		expect(res.result?.providerId).toBe("faux");
		expect(res.result?.modelId).toBe("echo");
		expect(res.result?.ok).toBe(true);
		expect(typeof res.result?.latencyMs).toBe("number");
		expect(res.result?.error).toBeUndefined();
	});

	it("returns not_found when testing an unconfigured provider or unknown provider", async () => {
		const scope = await adminScope("default");

		const unconfigured = await callApi(
			"account.credentials.test",
			{ providerId: "openai" },
			scope,
		);
		expect(unconfigured.ok).toBe(false);
		expect(unconfigured.error?.code).toBe("not_found");

		const unknown = await callApi(
			"account.credentials.test",
			{ providerId: "nonexistent-provider" },
			scope,
		);
		expect(unknown.ok).toBe(false);
		expect(unknown.error?.code).toBe("not_found");
	});

	it("returns ok: false with an error message when a configured key fails against the provider", async () => {
		const scope = await adminScope("default");

		const setRes = await callApi(
			"account.credentials.set",
			{
				providerId: "openai",
				credential: { type: "api_key", apiKey: "sk-invalid-test-key" },
			},
			scope,
		);
		expect(setRes.ok).toBe(true);

		const testRes = await callApi<AccountCredentialsTestResult>(
			"account.credentials.test",
			{ providerId: "openai" },
			scope,
		);
		expect(testRes.ok).toBe(true);
		expect(testRes.result?.providerId).toBe("openai");
		expect(testRes.result?.ok).toBe(false);
		expect(typeof testRes.result?.latencyMs).toBe("number");
		expect(testRes.result?.error).toBeTruthy();
	});
});
