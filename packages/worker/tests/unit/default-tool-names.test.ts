import { describe, expect, it } from "bun:test";
import {
	BASH_TOOL_NAME,
	CATALOG_TOOL_NAMES,
	CODE_EXECUTE_TOOL_NAME,
	effectiveToolNames,
	TOOL_CATALOG,
} from "@cadmus/contract/tools";

describe("catalog tool names", () => {
	it("lists every catalog tool uniformly including bash and code.execute", () => {
		expect(CATALOG_TOOL_NAMES).toEqual(TOOL_CATALOG.map((entry) => entry.name));
		expect(CATALOG_TOOL_NAMES).toContain(BASH_TOOL_NAME);
		expect(CATALOG_TOOL_NAMES).toContain("web.search");
		expect(CATALOG_TOOL_NAMES).toContain("x.search");
		expect(CATALOG_TOOL_NAMES).toContain(CODE_EXECUTE_TOOL_NAME);
	});
});

describe("effective tool names", () => {
	it("drops code.execute only when workspaceEnvEnabled is true and bash is allowed", () => {
		expect(
			effectiveToolNames(undefined, { workspaceEnvEnabled: true }),
		).toEqual(
			CATALOG_TOOL_NAMES.filter((name) => name !== CODE_EXECUTE_TOOL_NAME),
		);
		expect(
			effectiveToolNames(undefined, { workspaceEnvEnabled: false }),
		).toBeUndefined();
		expect(
			effectiveToolNames([...CATALOG_TOOL_NAMES], {
				workspaceEnvEnabled: false,
			}),
		).toEqual([...CATALOG_TOOL_NAMES]);
		expect(
			effectiveToolNames([...CATALOG_TOOL_NAMES], {
				workspaceEnvEnabled: true,
			}),
		).toEqual(
			CATALOG_TOOL_NAMES.filter((name) => name !== CODE_EXECUTE_TOOL_NAME),
		);
		expect(
			effectiveToolNames(["bash", "read"], { workspaceEnvEnabled: true }),
		).toEqual(["bash", "read"]);
		expect(
			effectiveToolNames(["read", CODE_EXECUTE_TOOL_NAME], {
				workspaceEnvEnabled: true,
			}),
		).toEqual(["read", CODE_EXECUTE_TOOL_NAME]);
	});
});
