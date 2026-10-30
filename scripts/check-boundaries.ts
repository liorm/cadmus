/**
 * Fails when a client imports backend source, or when the contract package
 * imports anything other than `typebox`.
 *
 * web/ and cli/ may import `@cadmus/contract/types`, `@cadmus/contract/routes`,
 * `@cadmus/contract/tools`, and `@cadmus/contract/client`. The CLI may also
 * import `@cadmus/contract/schemas` to render help from the command schemas.
 * They may not import the bare package,
 * `@cadmus/contract/schemas`, the generated OpenAPI or AsyncAPI documents,
 * `src/`, or `daemon/`.
 * `import()` and `require()` template literals that interpolate are rejected
 * as a non-static specifier. packages/contract may import `typebox` and
 * relative files inside the package.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	clientImportReason,
	findImportSpecifiers,
	nonStaticSpecifierReason,
} from "./boundary-scan.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const clientRoots = ["packages/web/src", "packages/cli/src"];
const cliSchemaAllow = ["@cadmus/contract/schemas"];
const contractRoots = ["packages/contract/src", "packages/contract/generated"];

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);

type Violation = {
	file: string;
	line: number;
	specifier: string;
	reason: string;
};

function walk(dir: string): string[] {
	const abs = resolve(root, dir);
	let entries: string[] = [];
	try {
		entries = readdirSync(abs);
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const name of entries) {
		if (name === "node_modules" || name === "dist") continue;
		const path = join(abs, name);
		const stat = statSync(path);
		if (stat.isDirectory()) {
			files.push(...walk(path.slice(root.length + 1)));
		} else if (sourceExtensions.has(extname(name))) {
			files.push(path);
		}
	}
	return files;
}

function extname(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot === -1 ? "" : name.slice(dot);
}

function contractAllowed(file: string, specifier: string): string | undefined {
	if (specifier === "typebox" || specifier.startsWith("typebox/")) {
		return undefined;
	}
	if (specifier.startsWith("./") || specifier.startsWith("../")) {
		const resolved = resolve(dirname(file), specifier);
		const contractRoot = resolve(root, "packages/contract") + sep;
		if (
			resolved.startsWith(contractRoot) ||
			resolved === contractRoot.slice(0, -1)
		) {
			return undefined;
		}
		return "relative import escapes packages/contract";
	}
	return "contract may import only typebox and relative files inside the package";
}

const violations: Violation[] = [];

for (const dir of clientRoots) {
	for (const file of walk(dir)) {
		const text = readFileSync(file, "utf8");
		for (const found of findImportSpecifiers(text)) {
			const reason =
				nonStaticSpecifierReason(found.nonStatic) ??
				clientImportReason(found.specifier, {
					allow: file.includes(`${sep}packages${sep}cli${sep}`)
						? cliSchemaAllow
						: undefined,
				});
			if (reason) {
				violations.push({
					file,
					line: found.line,
					specifier: found.specifier,
					reason,
				});
			}
		}
	}
}

for (const dir of contractRoots) {
	for (const file of walk(dir)) {
		const text = readFileSync(file, "utf8");
		for (const found of findImportSpecifiers(text)) {
			const reason =
				nonStaticSpecifierReason(found.nonStatic) ??
				contractAllowed(file, found.specifier);
			if (reason) {
				violations.push({
					file,
					line: found.line,
					specifier: found.specifier,
					reason,
				});
			}
		}
	}
}

if (violations.length > 0) {
	for (const violation of violations) {
		const rel = violation.file.startsWith(root)
			? violation.file.slice(root.length + 1)
			: violation.file;
		process.stderr.write(
			`${rel}:${violation.line}: ${violation.reason} (${violation.specifier})\n`,
		);
	}
	process.exit(1);
}

process.stdout.write("API boundaries hold.\n");
