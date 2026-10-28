import { describe, expect, it } from "bun:test";
import { stat } from "node:fs/promises";
import {
	deleteDaemonConfig,
	loadDaemonConfig,
	saveDaemonConfig,
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
});
