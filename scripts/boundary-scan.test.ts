import { describe, expect, it } from "bun:test";
import {
	clientImportReason,
	findImportSpecifiers,
	isAllowedClientContractSpecifier,
	nonStaticSpecifierReason,
} from "./boundary-scan.ts";

/** Text of a template substitution. The marker is split so this file stays static. */
function subst(expr: string): string {
	return `${"$"}{${expr}}`;
}

function specifierAt(source: string, specifier: string) {
	const found = findImportSpecifiers(source).filter(
		(item) => item.specifier === specifier,
	);
	expect(found).toHaveLength(1);
	const match = found[0];
	if (!match) throw new Error(`missing ${specifier}`);
	expect(match.line).toBe(source.slice(0, match.index).split("\n").length);
	return match;
}

describe("findImportSpecifiers", () => {
	it("reads a multi-line dynamic import()", () => {
		const source = [
			"const backend = await import(",
			'\t"../../src/protocol.js"',
			");",
			"",
		].join("\n");
		const match = specifierAt(source, "../../src/protocol.js");
		expect(match.line).toBe(2);
	});

	it("reads a dynamic import() with a comment before the specifier", () => {
		const source = [
			"const backend = await import(",
			"\t/* backend */",
			'\t"../../src/protocol.js"',
			");",
			"",
		].join("\n");
		expect(specifierAt(source, "../../src/protocol.js").line).toBe(3);
	});

	it("reads a multi-line from clause", () => {
		const source = ["import { foo } from", '\t"../../src/foo.js";', ""].join(
			"\n",
		);
		expect(specifierAt(source, "../../src/foo.js").line).toBe(2);
	});

	it("reads a multi-line export from clause", () => {
		const source = [
			"export type { Foo }",
			'\tfrom "../../daemon/cli.js";',
			"",
		].join("\n");
		expect(specifierAt(source, "../../daemon/cli.js").line).toBe(2);
	});

	it("reads export * from and a named re-export", () => {
		const source = [
			'export * from "../../src/index.js";',
			"export {",
			"\tbar,",
			'} from "../../daemon/session.js";',
			"",
		].join("\n");
		const found = findImportSpecifiers(source);
		expect(found.map((item) => item.specifier)).toEqual([
			"../../src/index.js",
			"../../daemon/session.js",
		]);
		expect(found[1]?.line).toBe(4);
	});

	it("reads multi-line import type", () => {
		const source = [
			"import type {",
			"\tFoo,",
			'} from "@cadmus/contract/schemas";',
			"",
		].join("\n");
		expect(specifierAt(source, "@cadmus/contract/schemas").line).toBe(3);
	});

	it("reads a multi-line require()", () => {
		const source = [
			"const doc = require(",
			'\t"@cadmus/contract/openapi.json"',
			");",
			"",
		].join("\n");
		expect(specifierAt(source, "@cadmus/contract/openapi.json").line).toBe(2);
	});

	it("reads TypeScript import equals require()", () => {
		const source = 'import wire = require("../../src/shim.js");\n';
		expect(specifierAt(source, "../../src/shim.js").line).toBe(1);
	});

	it("reads no-substitution template literals in import() and require()", () => {
		const source = [
			"const backend = await import(",
			"\t`../../src/protocol.js`",
			");",
			"const schemas = require(`@cadmus/contract/schemas`);",
			"const wire = require(",
			"\t/* spec */",
			"\t`../../src/shim.js`,",
			");",
			"",
		].join("\n");
		const found = findImportSpecifiers(source);
		expect(
			found.map((item) => [item.specifier, item.line, item.nonStatic]),
		).toEqual([
			["../../src/protocol.js", 2, undefined],
			["@cadmus/contract/schemas", 4, undefined],
			["../../src/shim.js", 7, undefined],
		]);
		for (const item of found) {
			expect(nonStaticSpecifierReason(item.nonStatic)).toBeUndefined();
			expect(clientImportReason(item.specifier)).toBeTruthy();
		}
	});

	it("flags import() and require() templates that interpolate", () => {
		const name = subst("name");
		const kind = subst("kind");
		const base = subst("base");
		const nestedExpr = subst('await import("../../src/protocol.js")');
		const source = [
			`const backend = await import(\`../../src/${name}.js\`);`,
			"const schemas = require(",
			`\t\`@cadmus/contract/${kind}\``,
			");",
			`const nested = await import(\`${nestedExpr}\`);`,
			`const dynamic = await import(\`${base}\`);`,
			"",
		].join("\n");
		const found = findImportSpecifiers(source);
		expect(
			found.map((item) => [item.specifier, item.line, item.nonStatic]),
		).toEqual([
			[`\`../../src/${name}.js\``, 1, true],
			[`\`@cadmus/contract/${kind}\``, 3, true],
			[`\`${nestedExpr}\``, 5, true],
			["../../src/protocol.js", 5, undefined],
			[`\`${base}\``, 6, true],
		]);
		for (const item of found) {
			if (!item.nonStatic) {
				expect(clientImportReason(item.specifier)).toBeTruthy();
				continue;
			}
			expect(nonStaticSpecifierReason(item.nonStatic)).toBe(
				"non-static specifier",
			);
			expect(
				clientImportReason(item.specifier, { nonStatic: item.nonStatic }),
			).toBe("non-static specifier");
		}
		const opaque = found.find((item) => item.specifier === `\`${base}\``);
		expect(opaque).toBeDefined();
		expect(clientImportReason(opaque?.specifier ?? "")).toBeUndefined();
	});

	it("keeps an escaped substitution as a static template specifier", () => {
		const escaped = `\\${subst("not")}`;
		const source = `const backend = await import(\`${escaped}/file.js\`);\n`;
		const match = specifierAt(source, `${subst("not")}/file.js`);
		expect(match.nonStatic).toBeUndefined();
		expect(nonStaticSpecifierReason(match.nonStatic)).toBeUndefined();
		expect(clientImportReason(match.specifier)).toBeUndefined();
	});

	it("reads import() inside a template expression", () => {
		const source = `const load = () => \`${"$"}{await import("../../src/protocol.js")}\`;\n`;
		expect(specifierAt(source, "../../src/protocol.js").line).toBe(1);
	});

	it("keeps allowed contract entry points", () => {
		const source = [
			'import type { BotRecord } from "@cadmus/contract/types";',
			"import {",
			"\tencodePayloadQuery,",
			'} from "@cadmus/contract/routes";',
			"",
		].join("\n");
		const found = findImportSpecifiers(source);
		expect(found.map((item) => [item.specifier, item.line])).toEqual([
			["@cadmus/contract/types", 1],
			["@cadmus/contract/routes", 4],
		]);
		for (const item of found) {
			expect(isAllowedClientContractSpecifier(item.specifier)).toBe(true);
			expect(clientImportReason(item.specifier)).toBeUndefined();
		}
	});

	it("ignores comments, strings, and import.meta", () => {
		const source = [
			'// import "../../src/ignored.js"',
			'/* require("../../daemon/cli.js") */',
			'const sample = "import \\"../../src/ignored.js\\"";',
			"const url = import.meta.url;",
			'export const label = "from \\"../../src/nope.js\\"";',
			"",
		].join("\n");
		expect(findImportSpecifiers(source)).toEqual([]);
	});

	it("does not treat a binding named from inside braces as a module specifier", () => {
		const source = 'import { from } from "@cadmus/contract/types";\n';
		expect(findImportSpecifiers(source).map((item) => item.specifier)).toEqual([
			"@cadmus/contract/types",
		]);
	});
});

describe("client contract specifiers", () => {
	it("allows only types and routes", () => {
		expect(isAllowedClientContractSpecifier("@cadmus/contract/types")).toBe(
			true,
		);
		expect(isAllowedClientContractSpecifier("@cadmus/contract/routes")).toBe(
			true,
		);
		for (const specifier of [
			"@cadmus/contract",
			"@cadmus/contract/schemas",
			"@cadmus/contract/openapi.json",
			"@cadmus/contract/asyncapi.json",
			"../../src/protocol.js",
			"../../daemon/cli.js",
			"../../packages/worker/src/protocol.js",
			"../../packages/daemon/src/cli.js",
		]) {
			expect(isAllowedClientContractSpecifier(specifier)).toBe(false);
			expect(clientImportReason(specifier)).toBeTruthy();
		}
		expect(clientImportReason("./local.js")).toBeUndefined();
		expect(clientImportReason("react")).toBeUndefined();
	});
});
