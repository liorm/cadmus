import { describe, expect, it } from "bun:test";
import {
	type DecodedPairingToken,
	PAIRING_TOKEN_PREFIX,
	parsePairingToken,
	performPairing,
} from "../src/pair.js";

function encodeToken(payload: DecodedPairingToken): string {
	const json = JSON.stringify(payload);
	const base64url = Buffer.from(json, "utf-8").toString("base64url");
	return `${PAIRING_TOKEN_PREFIX}${base64url}`;
}

describe("daemon pairing logic", () => {
	const validPayload: DecodedPairingToken = {
		v: 1,
		accountId: "acct_123",
		envId: "ld_456",
		url: "http://example.com",
		wsUrl: "ws://example.com/tools-env/ws",
		workspace: "/tmp/test-workspace",
		persist: true,
		confine: false,
		nonce: "nonce-uuid-789",
		exp: Date.now() + 15 * 60 * 1000,
		secret: "secret-hex-abc",
	};

	it("parses a valid pairing token", () => {
		const token = encodeToken(validPayload);
		const parsed = parsePairingToken(token);
		expect(parsed).toEqual(validPayload);
	});

	it("rejects tokens with invalid prefix or malformed json", () => {
		expect(() => parsePairingToken("invalid_prefix_123")).toThrow(
			"Invalid pairing token",
		);
		expect(() =>
			parsePairingToken(`${PAIRING_TOKEN_PREFIX}not-valid-base64-json`),
		).toThrow("Failed to decode");
	});

	it("rejects tokens missing required fields", () => {
		const badPayload = { ...validPayload } as Partial<DecodedPairingToken>;
		delete badPayload.accountId;
		const token = encodeToken(badPayload as DecodedPairingToken);
		expect(() => parsePairingToken(token)).toThrow("Missing required fields");
	});

	it("rejects expired tokens before making any network calls", async () => {
		const expiredPayload: DecodedPairingToken = {
			...validPayload,
			exp: Date.now() - 1000, // expired 1s ago
		};
		const token = encodeToken(expiredPayload);
		await expect(
			performPairing({
				pairingToken: token,
			}),
		).rejects.toThrow("Pairing token has expired");
	});

	it("exchanges pairing token with backend and saves configuration", async () => {
		const token = encodeToken(validPayload);
		const testConfigPath = `/tmp/test-daemon-${crypto.randomUUID()}.json`;

		const mockFetch: typeof fetch = (async (
			url: string | URL | Request,
			init?: RequestInit,
		) => {
			expect(url.toString()).toBe("http://example.com/tools-env/pair");
			expect(init?.method).toBe("POST");
			const body = JSON.parse(init?.body as string) as {
				pairingToken: string;
				name: string;
			};
			expect(body.pairingToken).toBe(token);
			expect(body.name).toBe("Test Rig");

			return new Response(
				JSON.stringify({
					ok: true,
					token: "cadmus_dk_mock_permanent_token",
					envId: "ld_456",
					url: "http://example.com",
					wsUrl: "ws://example.com/tools-env/ws",
					workspacePath: "/tmp/test-workspace",
					persist: true,
					confineToWorkspace: false,
					name: "Test Rig",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const result = await performPairing({
			pairingToken: token,
			name: "Test Rig",
			customConfigPath: testConfigPath,
			fetchImpl: mockFetch,
		});

		expect(result.token).toBe("cadmus_dk_mock_permanent_token");
		expect(result.envId).toBe("ld_456");
		expect(result.workspacePath).toBe("/tmp/test-workspace");
		expect(result.url).toBe("ws://example.com/tools-env/ws");
	});
});
