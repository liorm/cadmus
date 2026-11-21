import { describe, expect, it } from "bun:test";
import {
	clientImportReason,
	e2eImportReason,
	findImportSpecifiers,
	nonStaticSpecifierReason,
} from "../../scripts/boundary-scan.ts";

describe("findImportSpecifiers", () => {
	it("finds static, multi-line, type, export-from, dynamic import(), and require() specifiers", () => {
		const source = `
			import { a } from "@cadmus/contract/types";
			import type {
				b,
			} from "@cadmus/contract/routes";
			export { c } from "@cadmus/contract/tools";
			export type * from "@cadmus/contract/client";
			import "./side-effect.js";
			const d = await import("../packages/worker/src/index.ts");
			const e = require(\`./dynamic-\${name}.js\`);
			// import "ignored-in-comment"
			const str = "import 'ignored-in-string'";
		`;
		const found = findImportSpecifiers(source);
		expect(
			found.map((item) => ({
				specifier: item.specifier,
				nonStatic: Boolean(item.nonStatic),
			})),
		).toEqual([
			{ specifier: "@cadmus/contract/types", nonStatic: false },
			{ specifier: "@cadmus/contract/routes", nonStatic: false },
			{ specifier: "@cadmus/contract/tools", nonStatic: false },
			{ specifier: "@cadmus/contract/client", nonStatic: false },
			{ specifier: "./side-effect.js", nonStatic: false },
			{ specifier: "../packages/worker/src/index.ts", nonStatic: false },
			{ specifier: ["`./dynamic-$", "{name}.js`"].join(""), nonStatic: true },
		]);
	});
});

describe("clientImportReason", () => {
	it("allows permitted contract subpaths and rejects worker/daemon or bare contract", () => {
		expect(clientImportReason("@cadmus/contract/types")).toBeUndefined();
		expect(clientImportReason("@cadmus/contract/routes")).toBeUndefined();
		expect(clientImportReason("@cadmus/contract/tools")).toBeUndefined();
		expect(clientImportReason("@cadmus/contract/client")).toBeUndefined();
		expect(
			clientImportReason("@cadmus/contract/schemas", {
				allow: ["@cadmus/contract/schemas"],
			}),
		).toBeUndefined();
		expect(clientImportReason("@cadmus/contract")).toBeDefined();
		expect(clientImportReason("@cadmus/contract/schemas")).toBeDefined();
		expect(clientImportReason("../../worker/src/index.ts")).toBeDefined();
		expect(clientImportReason("../../web-app/package.json")).toBeDefined();
		expect(clientImportReason("../../login-app/index.html")).toBeDefined();
		expect(clientImportReason("../../cli/package.json")).toBeDefined();
		expect(
			nonStaticSpecifierReason(true) ??
				clientImportReason("x", { nonStatic: true }),
		).toBe("non-static specifier");
	});
});

describe("e2eImportReason", () => {
	it("forbids packages/* everywhere in e2e/ and restricts contract imports to e2e/helpers.ts", () => {
		expect(
			e2eImportReason("../packages/worker/src/index.ts", { isHelper: true }),
		).toBeDefined();
		expect(
			e2eImportReason("../packages/worker/src/index.ts", { isHelper: false }),
		).toBeDefined();
		expect(e2eImportReason("@cadmus/worker", { isHelper: true })).toBeDefined();
		expect(
			e2eImportReason("@cadmus/contract/client", { isHelper: true }),
		).toBeUndefined();
		expect(
			e2eImportReason("@cadmus/contract/schemas", { isHelper: true }),
		).toBeUndefined();
		expect(
			e2eImportReason("cloudflare:test", { isHelper: true }),
		).toBeUndefined();
		expect(
			e2eImportReason("@cadmus/contract/client", { isHelper: false }),
		).toBeDefined();
		expect(
			e2eImportReason("cloudflare:test", { isHelper: false }),
		).toBeDefined();
		expect(
			e2eImportReason("./helpers.js", { isHelper: false }),
		).toBeUndefined();
		expect(e2eImportReason("vitest", { isHelper: false })).toBeUndefined();
	});
});
