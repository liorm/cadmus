import { describe, expect, it } from "bun:test";
import {
	availableAllowlistNames,
	BASH_TOOL_NAME,
	CATALOG_TOOL_NAMES,
	CODE_EXECUTE_TOOL_NAME,
	categorySelectionState,
	defaultDisplayedTools,
	displayedAllowlist,
	effectiveToolNames,
	isKnownReadOnlyTool,
	knownReadOnlyToolNames,
	persistAllowlist,
	TOOL_CATALOG,
} from "@cadmus/contract/tools";

describe("TOOL_CATALOG", () => {
	it("includes every catalog tool uniformly including bash", () => {
		expect(TOOL_CATALOG.map((entry) => entry.name)).toEqual([
			...CATALOG_TOOL_NAMES,
		]);
		expect(CATALOG_TOOL_NAMES).toContain(BASH_TOOL_NAME);
		expect(CATALOG_TOOL_NAMES).toContain(CODE_EXECUTE_TOOL_NAME);
	});

	it("marks read-only from execute() behavior, not name suffixes", () => {
		expect(isKnownReadOnlyTool("read")).toBe(true);
		expect(isKnownReadOnlyTool("ls")).toBe(true);
		expect(isKnownReadOnlyTool("find")).toBe(true);
		expect(isKnownReadOnlyTool("grep")).toBe(true);
		expect(isKnownReadOnlyTool("schedule_list")).toBe(true);
		expect(isKnownReadOnlyTool("list_bots")).toBe(true);
		expect(isKnownReadOnlyTool("web.fetch")).toBe(true);
		expect(isKnownReadOnlyTool("write")).toBe(false);
		expect(isKnownReadOnlyTool("edit")).toBe(false);
		expect(isKnownReadOnlyTool("delete")).toBe(false);
		expect(isKnownReadOnlyTool("bash")).toBe(false);
		expect(isKnownReadOnlyTool("task_get")).toBe(false);
		expect(isKnownReadOnlyTool("search_bot")).toBe(false);
		expect(isKnownReadOnlyTool("code.execute")).toBe(false);
		expect(isKnownReadOnlyTool("mystery_read")).toBe(false);
	});

	it("excludes purely internal and situational follow-up tools from the catalog", () => {
		const names = TOOL_CATALOG.map((entry) => entry.name);
		expect(names).not.toContain("end_conversation");
		expect(names).not.toContain("task_get");
		expect(names).not.toContain("task_finish");
		expect(names).not.toContain("task_remove");
		expect(names).not.toContain("task_list");
		expect(names).toContain("task_add");
	});
});

describe("available allowlist", () => {
	it("includes bash and code.execute seamlessly when no model restricts providers", () => {
		const names = availableAllowlistNames();
		expect(names).toEqual([...CATALOG_TOOL_NAMES]);
		expect(names).toContain(BASH_TOOL_NAME);
		expect(names).toContain(CODE_EXECUTE_TOOL_NAME);
	});

	it("filters out provider tools for unsupported model providers while keeping bash", () => {
		const anthropicNames = availableAllowlistNames(
			"anthropic/claude-3-5-sonnet",
		);
		expect(anthropicNames).toContain(BASH_TOOL_NAME);
		expect(anthropicNames).not.toContain("web.search");
		expect(anthropicNames).not.toContain("x.search");
		expect(anthropicNames).not.toContain("code.execute");

		const xaiNames = availableAllowlistNames("xai/grok-2");
		expect(xaiNames).toContain(BASH_TOOL_NAME);
		expect(xaiNames).toContain("web.search");
		expect(xaiNames).toContain("x.search");
		expect(xaiNames).toContain("code.execute");

		const googleNames = availableAllowlistNames("google/gemini-4-hydrogen");
		expect(googleNames).toContain(BASH_TOOL_NAME);
		expect(googleNames).toContain("web.search");
		expect(googleNames).not.toContain("x.search");
		expect(googleNames).toContain("code.execute");
	});
});

describe("effectiveToolNames", () => {
	it("suppresses code.execute only when workspaceEnvEnabled and bash is allowed", () => {
		expect(
			effectiveToolNames(undefined, { workspaceEnvEnabled: false }),
		).toBeUndefined();
		expect(
			effectiveToolNames(undefined, { workspaceEnvEnabled: true }),
		).toEqual(
			CATALOG_TOOL_NAMES.filter((name) => name !== CODE_EXECUTE_TOOL_NAME),
		);
		expect(
			effectiveToolNames(["web.fetch", CODE_EXECUTE_TOOL_NAME], {
				workspaceEnvEnabled: true,
			}),
		).toEqual(["web.fetch", CODE_EXECUTE_TOOL_NAME]);
		expect(
			effectiveToolNames([...CATALOG_TOOL_NAMES], {
				workspaceEnvEnabled: true,
			}),
		).toEqual(
			CATALOG_TOOL_NAMES.filter((name) => name !== CODE_EXECUTE_TOOL_NAME),
		);
	});
});

describe("persistAllowlist", () => {
	it("saves null for the default displayed set", () => {
		expect(
			persistAllowlist({
				selected: defaultDisplayedTools(),
				available: availableAllowlistNames(),
				previous: undefined,
			}),
		).toBeNull();
	});

	it("keeps hidden model-specific picks when switching models", () => {
		const persisted = persistAllowlist({
			selected: ["read"],
			available: availableAllowlistNames("anthropic/claude-3-5-sonnet"),
			previous: ["read", "web.search"],
			model: "anthropic/claude-3-5-sonnet",
		});
		expect(persisted).toEqual(["read", "web.search"]);
	});

	it("persists an explicit allowlist without adding unselected tools", () => {
		const persisted = persistAllowlist({
			selected: ["read"],
			available: availableAllowlistNames(),
			previous: ["read"],
		});
		expect(persisted).toEqual(["read"]);
		expect(persisted).not.toContain("bash");
	});
});

describe("displayedAllowlist and category state", () => {
	it("filters stored names to the current model provider", () => {
		expect(
			displayedAllowlist({
				stored: ["read", "bash", "web.search"],
				available: availableAllowlistNames("anthropic/claude-3-5-sonnet"),
				model: "anthropic/claude-3-5-sonnet",
			}),
		).toEqual(["read", "bash"]);
	});

	it("reports mixed category membership", () => {
		expect(categorySelectionState(["a", "b", "c"], new Set(["a", "c"]))).toBe(
			"mixed",
		);
		expect(categorySelectionState(["a", "b"], new Set(["a", "b"]))).toBe("all");
		expect(categorySelectionState(["a", "b"], new Set())).toBe("none");
	});

	it("read-only names ignore unknown tools", () => {
		expect(knownReadOnlyToolNames(["read", "mystery_read", "bash"])).toEqual([
			"read",
		]);
	});
});
