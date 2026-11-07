import { describe, expect, it } from "bun:test";
import {
	availableAllowlistNames,
	CODE_EXECUTE_TOOL_NAME,
	CODING_TOOL_NAMES,
	categorySelectionState,
	codingToolsEnvWouldOffer,
	DEFAULT_CADMUS_TOOL_NAMES,
	defaultDisplayedTools,
	displayedAllowlist,
	isKnownReadOnlyTool,
	knownReadOnlyToolNames,
	persistAllowlist,
	TOOL_CATALOG,
} from "@cadmus/contract/tools";

describe("TOOL_CATALOG", () => {
	it("lists every default Cadmus tool then the coding tools", () => {
		expect(
			TOOL_CATALOG.filter((entry) => !entry.codingEnv).map(
				(entry) => entry.name,
			),
		).toEqual([...DEFAULT_CADMUS_TOOL_NAMES]);
		expect(
			TOOL_CATALOG.filter((entry) => entry.codingEnv).map(
				(entry) => entry.name,
			),
		).toEqual([...CODING_TOOL_NAMES]);
	});

	it("marks read-only from execute() behavior, not name suffixes", () => {
		expect(isKnownReadOnlyTool("knowledge_read")).toBe(true);
		expect(isKnownReadOnlyTool("memory_read")).toBe(true);
		expect(isKnownReadOnlyTool("schedule_list")).toBe(true);
		expect(isKnownReadOnlyTool("task_list")).toBe(true);
		expect(isKnownReadOnlyTool("list_bots")).toBe(true);
		expect(isKnownReadOnlyTool("web.fetch")).toBe(true);
		expect(isKnownReadOnlyTool("read")).toBe(true);
		expect(isKnownReadOnlyTool("task_get")).toBe(false);
		expect(isKnownReadOnlyTool("search_bot")).toBe(false);
		expect(isKnownReadOnlyTool("memory_update")).toBe(false);
		expect(isKnownReadOnlyTool("code.execute")).toBe(false);
		expect(isKnownReadOnlyTool("mystery_read")).toBe(false);
	});
});

describe("codingToolsEnvWouldOffer", () => {
	const envKindById = { jb: "just-bash", daemon: "local-daemon" };

	it("is false for inherit with no account default and for Off", () => {
		expect(
			codingToolsEnvWouldOffer({
				botSetting: null,
				accountDefaultEnvId: null,
				envKindById,
			}),
		).toBe(false);
		expect(
			codingToolsEnvWouldOffer({
				botSetting: { enabled: false },
				accountDefaultEnvId: "jb",
				envKindById,
			}),
		).toBe(false);
	});

	it("is true for a just-bash pin and for inherit of an account default", () => {
		expect(
			codingToolsEnvWouldOffer({
				botSetting: { enabled: true, binding: { envId: "jb" } },
				accountDefaultEnvId: null,
				envKindById,
			}),
		).toBe(true);
		expect(
			codingToolsEnvWouldOffer({
				botSetting: null,
				accountDefaultEnvId: "jb",
				envKindById,
			}),
		).toBe(true);
	});

	it("is false when the env id is missing from the catalog", () => {
		expect(
			codingToolsEnvWouldOffer({
				botSetting: { enabled: true, binding: { envId: "ghost" } },
				envKindById,
			}),
		).toBe(false);
	});
});

describe("available allowlist", () => {
	it("hides coding tools and keeps code.execute without a coding env", () => {
		const names = availableAllowlistNames(false);
		expect(names).toEqual([...DEFAULT_CADMUS_TOOL_NAMES]);
		expect(names).toContain(CODE_EXECUTE_TOOL_NAME);
		for (const name of CODING_TOOL_NAMES) {
			expect(names).not.toContain(name);
		}
	});

	it("shows coding tools and drops code.execute when a coding env is offered", () => {
		const names = availableAllowlistNames(true);
		expect(names).toContain("bash");
		expect(names).not.toContain(CODE_EXECUTE_TOOL_NAME);
	});
});

describe("persistAllowlist", () => {
	it("saves null for the default displayed set", () => {
		expect(
			persistAllowlist({
				selected: defaultDisplayedTools(false),
				available: availableAllowlistNames(false),
				previous: undefined,
				codingEnvOffered: false,
			}),
		).toBeNull();
	});

	it("keeps hidden coding picks when the env is cleared", () => {
		const persisted = persistAllowlist({
			selected: ["memory_read"],
			available: availableAllowlistNames(false),
			previous: ["memory_read", "bash"],
			codingEnvOffered: false,
		});
		expect(persisted).toEqual(["memory_read", "bash"]);
	});

	it("does not add coding tools that were not selected", () => {
		const persisted = persistAllowlist({
			selected: ["memory_read"],
			available: availableAllowlistNames(true),
			previous: ["memory_read"],
			codingEnvOffered: true,
		});
		expect(persisted).toEqual(["memory_read"]);
		expect(persisted).not.toContain("bash");
	});
});

describe("displayedAllowlist and category state", () => {
	it("filters stored names to the current env", () => {
		expect(
			displayedAllowlist({
				stored: ["memory_read", "bash"],
				available: availableAllowlistNames(false),
				codingEnvOffered: false,
			}),
		).toEqual(["memory_read"]);
	});

	it("reports mixed category membership", () => {
		expect(categorySelectionState(["a", "b", "c"], new Set(["a", "c"]))).toBe(
			"mixed",
		);
		expect(categorySelectionState(["a", "b"], new Set(["a", "b"]))).toBe("all");
		expect(categorySelectionState(["a", "b"], new Set())).toBe("none");
	});

	it("read-only names ignore unknown tools", () => {
		expect(
			knownReadOnlyToolNames(["memory_read", "mystery_read", "bash"]),
		).toEqual(["memory_read"]);
	});
});
