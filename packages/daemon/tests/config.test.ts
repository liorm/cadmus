import { describe, expect, it } from "bun:test";
import { stat } from "node:fs/promises";
import {
	deleteDaemonConfig,
	getDaemonConfigValue,
	loadDaemonConfig,
	saveDaemonConfig,
	setDaemonConfigValue,
} from "../src/config.js";

describe("daemon configuration storage", () => {
	it("saves and loads daemon configuration with token", async () => {
		const testConfigPath = `/tmp/test-config-${crypto.randomUUID()}.json`;

		const saved = await saveDaemonConfig(
			{
				url: "wss://cadmus.example/tools-env/ws",
				envId: "ld_test_env",
				persist: true,
				confineToWorkspace: false,
				name: "Dev Machine",
				token: "cadmus_dk_test_secret_token",
			},
			testConfigPath,
		);

		expect(saved.configPath).toBe(testConfigPath);

		// Verify file permissions (0600 = owner read/write only) on POSIX
		if (process.platform !== "win32") {
			const fileStat = await stat(testConfigPath);
			expect(fileStat.mode & 0o077).toBe(0);
		}

		const loaded = await loadDaemonConfig(testConfigPath);
		expect(loaded).not.toBeNull();
		expect(loaded?.config.envId).toBe("ld_test_env");
		expect(loaded?.config.url).toBe("wss://cadmus.example/tools-env/ws");
		expect(loaded?.config).not.toHaveProperty("workspacePath");
		expect(loaded?.config.name).toBe("Dev Machine");
		expect(loaded?.token).toBe("cadmus_dk_test_secret_token");

		// Delete config
		const deleted = await deleteDaemonConfig(testConfigPath);
		expect(deleted).toBe(true);
		expect(await loadDaemonConfig(testConfigPath)).toBeNull();
	});

	it("gets and sets individual configuration values", async () => {
		const testConfigPath = `/tmp/test-config-${crypto.randomUUID()}.json`;

		await saveDaemonConfig(
			{
				url: "wss://cadmus.example/tools-env/ws",
				envId: "ld_test_env",
				persist: true,
				confineToWorkspace: false,
				name: "Initial Name",
				token: "cadmus_dk_initial_token",
			},
			testConfigPath,
		);

		// Test getDaemonConfigValue for full config
		const fullConfig = await getDaemonConfigValue(undefined, testConfigPath);
		const fullConfigValue = fullConfig.value as Record<string, unknown>;
		expect(fullConfigValue.envId).toBe("ld_test_env");
		expect(fullConfigValue.name).toBe("Initial Name");

		// Test getDaemonConfigValue for specific key
		const nameVal = await getDaemonConfigValue("name", testConfigPath);
		expect(nameVal.value).toBe("Initial Name");

		// Test setDaemonConfigValue string key
		const updatedName = await setDaemonConfigValue(
			"name",
			"Updated Name",
			testConfigPath,
		);
		expect(updatedName.value).toBe("Updated Name");
		expect((await getDaemonConfigValue("name", testConfigPath)).value).toBe(
			"Updated Name",
		);

		// Test setDaemonConfigValue boolean keys
		const updatedPersist = await setDaemonConfigValue(
			"persist",
			"false",
			testConfigPath,
		);
		expect(updatedPersist.value).toBe(false);
		expect((await getDaemonConfigValue("persist", testConfigPath)).value).toBe(
			false,
		);

		const updatedConfine = await setDaemonConfigValue(
			"confine",
			"true",
			testConfigPath,
		);
		expect(updatedConfine.value).toBe(true);
		expect(
			(await getDaemonConfigValue("confineToWorkspace", testConfigPath)).value,
		).toBe(true);

		// Test setting url and token
		await setDaemonConfigValue("url", "wss://other.example/ws", testConfigPath);
		expect((await getDaemonConfigValue("url", testConfigPath)).value).toBe(
			"wss://other.example/ws",
		);

		await setDaemonConfigValue("token", "cadmus_dk_new_token", testConfigPath);
		expect((await getDaemonConfigValue("token", testConfigPath)).value).toBe(
			"cadmus_dk_new_token",
		);

		// Rejects invalid boolean
		expect(
			setDaemonConfigValue("persist", "not-a-bool", testConfigPath),
		).rejects.toThrow("Invalid boolean value");

		// Rejects unknown key
		expect(
			setDaemonConfigValue("unknown_key", "val", testConfigPath),
		).rejects.toThrow("Unknown configuration key");

		await deleteDaemonConfig(testConfigPath);
	});
});
