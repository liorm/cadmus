import { describe, expect, it } from "bun:test";
import { SYSTEM_PROMPT } from "../../src/extensions/identity.js";
import { chooseToolsEnvIdentity } from "../../src/tools-env/pure.js";

describe("Virtual files enforcement", () => {
	it("enforces in SYSTEM_PROMPT that MEMORY.md and knowledge are virtual entities and not workspace files", () => {
		expect(SYSTEM_PROMPT).toContain("NOT files on disk or in the workspace");
		expect(SYSTEM_PROMPT).toContain("dedicated tools");
		expect(SYSTEM_PROMPT).toContain("memory_read");
		expect(SYSTEM_PROMPT).toContain("memory_update");
		expect(SYSTEM_PROMPT).toContain("knowledge_read");
		expect(SYSTEM_PROMPT).toContain("knowledge_update");
		expect(SYSTEM_PROMPT).toContain("knowledge_delete");
		expect(SYSTEM_PROMPT).toContain(
			"Never attempt to write or edit a file named memory.md",
		);
	});

	it("enforces in tools-env prompt that MEMORY.md and knowledge documents must not be touched via workspace tools", () => {
		const described = chooseToolsEnvIdentity({
			enabled: true,
			toolsOffered: true,
			connected: true,
			enabledSource: "bot",
			bindingSource: "bot",
			persist: true,
			confineToWorkspace: true,
			sharedWorkspace: false,
			harvest: false,
		});

		expect(described).toBeDefined();
		expect(described?.text).toContain(
			"MEMORY.md, SOUL.md, and knowledge/<slug>.md are virtual database entities, NOT workspace files",
		);
		expect(described?.text).toContain(
			"never use read, write, edit, or bash on them",
		);
	});
});
