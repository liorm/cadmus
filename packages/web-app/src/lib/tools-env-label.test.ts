import { describe, expect, it } from "bun:test";
import { toolsEnvLabel } from "./tools-env-label.ts";

describe("toolsEnvLabel", () => {
	it("reads Inherit, Off, and On with an env name", () => {
		expect(toolsEnvLabel(undefined)).toBe("Inherit");
		expect(toolsEnvLabel(null)).toBe("Inherit");
		expect(toolsEnvLabel({ enabled: false })).toBe("Off");
		expect(toolsEnvLabel({ enabled: true })).toBe("On");
		expect(
			toolsEnvLabel(
				{ enabled: true, binding: { envId: "env_1" } },
				{ env_1: "home-pi" },
			),
		).toBe("On · home-pi");
		expect(toolsEnvLabel({ enabled: true, binding: { envId: "env_1" } })).toBe(
			"On · env_1",
		);
	});
});
