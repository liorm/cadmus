import { describe, expect, it } from "bun:test";
import {
	clearDeviceCode,
	DEVICE_CODE_STORAGE_KEY,
	deviceCeremonyPhase,
	deviceCodeFromLocation,
	readStoredDeviceCode,
	rememberDeviceCode,
} from "../../src/lib/device-login";

describe("device login ceremony", () => {
	const memory = new Map<string, string>();
	globalThis.sessionStorage = {
		getItem: (key) => memory.get(key) ?? null,
		setItem: (key, value) => {
			memory.set(key, value);
		},
		removeItem: (key) => {
			memory.delete(key);
		},
		clear: () => {
			memory.clear();
		},
		key: () => null,
		length: 0,
	} as Storage;

	it("keeps a signed-out visit on the login page and stashes the code", () => {
		sessionStorage.clear();
		const code = deviceCodeFromLocation(
			"/login/device",
			{ code: "ABCD-EFGH" },
			null,
		);
		expect(code).toBe("ABCD-EFGH");
		expect(
			deviceCeremonyPhase({ code, signedIn: false, provisional: false }),
		).toBe("login");
		if (code) rememberDeviceCode(code);
		expect(readStoredDeviceCode()).toBe("ABCD-EFGH");
		expect(sessionStorage.getItem(DEVICE_CODE_STORAGE_KEY)).toBe("ABCD-EFGH");
	});

	it("shows approve when a finished session restores the stashed code", () => {
		const code = deviceCodeFromLocation("/", {}, "ABCD-EFGH");
		expect(
			deviceCeremonyPhase({ code, signedIn: true, provisional: false }),
		).toBe("approve");
	});

	it("does not approve a provisional session", () => {
		expect(
			deviceCeremonyPhase({
				code: "ABCD-EFGH",
				signedIn: true,
				provisional: true,
			}),
		).toBe("role");
		clearDeviceCode();
		expect(readStoredDeviceCode()).toBeNull();
	});
});
