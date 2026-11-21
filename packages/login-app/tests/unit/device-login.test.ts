import { describe, expect, it } from "bun:test";
import {
	clearDeviceCode,
	DEVICE_CODE_STORAGE_KEY,
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

	it("reads ?code on /login/device and stashes it in sessionStorage", () => {
		sessionStorage.clear();
		const code = deviceCodeFromLocation(
			"/login/device",
			"?code=ABCD-EFGH",
			null,
		);
		expect(code).toBe("ABCD-EFGH");
		if (code) rememberDeviceCode(code);
		expect(readStoredDeviceCode()).toBe("ABCD-EFGH");
		expect(sessionStorage.getItem(DEVICE_CODE_STORAGE_KEY)).toBe("ABCD-EFGH");
	});

	it("restores the stashed code on /login/device and on /login?auth_error=...", () => {
		expect(deviceCodeFromLocation("/login/device", "", "ABCD-EFGH")).toBe(
			"ABCD-EFGH",
		);
		expect(
			deviceCodeFromLocation("/login", "?auth_error=login_denied", "ABCD-EFGH"),
		).toBe("ABCD-EFGH");
	});

	it("does not restore the stashed code on plain /login without auth_error", () => {
		expect(deviceCodeFromLocation("/login", "", "ABCD-EFGH")).toBeNull();
		expect(
			deviceCodeFromLocation("/login", "?next=%2Fapp%2Fsettings", "ABCD-EFGH"),
		).toBeNull();
		expect(
			deviceCodeFromLocation("/login", "?auth_error=", "ABCD-EFGH"),
		).toBeNull();
		expect(
			deviceCodeFromLocation("/login", "?code=ABCD-EFGH", "ABCD-EFGH"),
		).toBeNull();
		clearDeviceCode();
		expect(readStoredDeviceCode()).toBeNull();
	});
});
