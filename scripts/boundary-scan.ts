/**
 * Pure import/export specifier scan for the API boundary check.
 *
 * The scan covers the whole file, including multi-line `import` / `export`
 * declarations, `import type`, `export ... from`, dynamic `import()`, and
 * `require()`. A no-substitution template literal is a static specifier.
 * `import()` and `require()` template literals that contain `${` are
 * non-static and are always rejected for clients. Comments and other string
 * or template literals are not imports. Line numbers are 1-based and counted
 * from the specifier's source index.
 */

export type FoundSpecifier = {
	specifier: string;
	line: number;
	index: number;
	/** `import()` / `require()` argument is a template literal that interpolates. */
	nonStatic?: boolean;
};

const ALLOWED_CLIENT_CONTRACT = new Set([
	"@cadmus/contract/types",
	"@cadmus/contract/routes",
	"@cadmus/contract/tools",
	"@cadmus/contract/client",
]);

const ALLOWED_E2E_HELPER_CONTRACT = new Set([
	"@cadmus/contract/types",
	"@cadmus/contract/routes",
	"@cadmus/contract/tools",
	"@cadmus/contract/client",
	"@cadmus/contract/schemas",
]);

export function isAllowedClientContractSpecifier(specifier: string): boolean {
	return ALLOWED_CLIENT_CONTRACT.has(specifier);
}

export function isAllowedE2eHelperContractSpecifier(
	specifier: string,
): boolean {
	return ALLOWED_E2E_HELPER_CONTRACT.has(specifier);
}

/**
 * Why an interpolating `import()` or `require()` template is rejected.
 * Returns undefined when the specifier is static.
 */
export function nonStaticSpecifierReason(
	nonStatic: boolean | undefined,
): string | undefined {
	if (!nonStatic) return undefined;
	return "non-static specifier";
}

/**
 * Why a client (`web/`, `app/`, or `cli/`) must not import `specifier`.
 * Returns undefined when the specifier is allowed.
 * `allow` adds package specifiers for one client (the CLI may import schemas).
 * Pass `nonStatic` for an `import()` / `require()` template that interpolates.
 */
export function clientImportReason(
	specifier: string,
	options?: { nonStatic?: boolean; allow?: readonly string[] },
): string | undefined {
	const dynamic = nonStaticSpecifierReason(options?.nonStatic);
	if (dynamic) return dynamic;
	if (
		isAllowedClientContractSpecifier(specifier) ||
		options?.allow?.includes(specifier)
	) {
		return undefined;
	}
	if (
		specifier === "@cadmus/contract" ||
		specifier.startsWith("@cadmus/contract/") ||
		specifier.startsWith("@cadmus/")
	) {
		return "clients may import only @cadmus/contract/types, @cadmus/contract/routes, @cadmus/contract/tools, and @cadmus/contract/client";
	}
	const normalized = specifier.replaceAll("\\", "/");
	if (
		/(^|\/)(src|worker|daemon|web-app|login-app|cli)(\/|$)/.test(normalized)
	) {
		return "clients must not import backend or sibling client source (src, worker, daemon, web-app, login-app, or cli)";
	}
	return undefined;
}

/**
 * Why an `e2e/` file must not import `specifier`.
 * Returns undefined when the specifier is allowed.
 *
 * - No file in `e2e/` may import from `packages/` or `@cadmus/worker`, `@cadmus/web-app`, `@cadmus/cli`, `@cadmus/daemon`.
 * - `e2e/helpers.ts` (`isHelper: true`) may import `@cadmus/contract/{types,routes,tools,client,schemas}`, `typebox`, `vitest`, `cloudflare:test`, and `node:*`.
 * - `e2e/*.test.ts` (`isHelper: false`) must import `@cadmus/contract` subpaths and `cloudflare:test` via `./helpers.js` only.
 */
export function e2eImportReason(
	specifier: string,
	options?: { nonStatic?: boolean; isHelper?: boolean },
): string | undefined {
	const dynamic = nonStaticSpecifierReason(options?.nonStatic);
	if (dynamic) return dynamic;
	const normalized = specifier.replaceAll("\\", "/");
	if (/(^|\/)(packages|src|worker|daemon|web|cli)(\/|$)/.test(normalized)) {
		return "e2e must not import from packages/* or backend/client source";
	}
	if (options?.isHelper) {
		if (isAllowedE2eHelperContractSpecifier(specifier)) {
			return undefined;
		}
		if (
			specifier === "@cadmus/contract" ||
			specifier.startsWith("@cadmus/contract/") ||
			specifier.startsWith("@cadmus/")
		) {
			return "e2e/helpers.ts may import only @cadmus/contract/types, @cadmus/contract/routes, @cadmus/contract/tools, @cadmus/contract/client, and @cadmus/contract/schemas";
		}
		if (specifier.startsWith("../")) {
			return "e2e/helpers.ts must not import relative files outside e2e/";
		}
		return undefined;
	}
	if (
		specifier === "@cadmus/contract" ||
		specifier.startsWith("@cadmus/contract/") ||
		specifier.startsWith("@cadmus/")
	) {
		return "e2e tests must import contract utilities through ./helpers.js, not directly from @cadmus/*";
	}
	if (specifier === "cloudflare:test") {
		return "e2e tests must use the worker fixture in ./helpers.js instead of importing cloudflare:test directly";
	}
	if (specifier.startsWith("../")) {
		return "e2e tests must not import relative files outside e2e/";
	}
	return undefined;
}

export function findImportSpecifiers(source: string): FoundSpecifier[] {
	const found: FoundSpecifier[] = [];
	const seen = new Set<number>();
	const n = source.length;

	function lineAt(index: number): number {
		return source.slice(0, index).split("\n").length;
	}

	function peek(index: number): string {
		return source[index] ?? "";
	}

	function pushSpecifier(
		value: string,
		index: number,
		nonStatic = false,
	): void {
		if (seen.has(index)) return;
		seen.add(index);
		const item: FoundSpecifier = {
			specifier: value,
			line: lineAt(index),
			index,
		};
		if (nonStatic) item.nonStatic = true;
		found.push(item);
	}

	function skipTrivia(index: number, end: number): number {
		let j = index;
		while (j < end) {
			const c = peek(j);
			if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f") {
				j++;
				continue;
			}
			if (c === "/" && peek(j + 1) === "/") {
				j += 2;
				while (j < end && peek(j) !== "\n") j++;
				continue;
			}
			if (c === "/" && peek(j + 1) === "*") {
				j += 2;
				while (j < end && !(peek(j) === "*" && peek(j + 1) === "/")) j++;
				j = Math.min(end, j + 2);
				continue;
			}
			break;
		}
		return j;
	}

	function readString(
		index: number,
	): { value: string; end: number } | undefined {
		const quote = peek(index);
		if (quote !== '"' && quote !== "'" && quote !== "`") return undefined;
		let j = index + 1;
		let value = "";
		while (j < n) {
			const c = peek(j);
			if (c === "\\") {
				value += peek(j + 1);
				j += 2;
				continue;
			}
			if (quote === "`" && c === "$" && peek(j + 1) === "{") return undefined;
			if (c === quote) return { value, end: j + 1 };
			if (quote !== "`" && c === "\n") return undefined;
			value += c;
			j++;
		}
		return undefined;
	}

	/** True when a backtick literal interpolates before its closing backtick. */
	function templateHasSubstitution(index: number, end: number): boolean {
		if (peek(index) !== "`") return false;
		let j = index + 1;
		while (j < end) {
			if (peek(j) === "\\") {
				j += 2;
				continue;
			}
			if (peek(j) === "`") return false;
			if (peek(j) === "$" && peek(j + 1) === "{") return true;
			j++;
		}
		return false;
	}

	function readIdent(
		index: number,
	): { value: string; end: number } | undefined {
		if (!/[A-Za-z_$]/.test(peek(index))) return undefined;
		let j = index + 1;
		while (j < n && /[A-Za-z0-9_$]/.test(peek(j))) j++;
		return { value: source.slice(index, j), end: j };
	}

	function matchingBrace(start: number, end: number): number {
		let depth = 1;
		let j = start;
		while (j < end && depth > 0) {
			const c = peek(j);
			if (c === "'" || c === '"') {
				const str = readString(j);
				j = str ? str.end : j + 1;
				continue;
			}
			if (c === "`") {
				j = scanTemplate(j, end);
				continue;
			}
			if (c === "/" && peek(j + 1) === "/") {
				j += 2;
				while (j < end && peek(j) !== "\n") j++;
				continue;
			}
			if (c === "/" && peek(j + 1) === "*") {
				j += 2;
				while (j < end && !(peek(j) === "*" && peek(j + 1) === "/")) j++;
				j = Math.min(end, j + 2);
				continue;
			}
			if (c === "{") depth++;
			else if (c === "}") {
				depth--;
				if (depth === 0) return j;
			}
			j++;
		}
		return j;
	}

	function scanTemplate(from: number, end: number): number {
		let j = from + 1;
		while (j < end) {
			if (peek(j) === "\\") {
				j += 2;
				continue;
			}
			if (peek(j) === "`") return j + 1;
			if (peek(j) === "$" && peek(j + 1) === "{") {
				const exprStart = j + 2;
				const exprEnd = matchingBrace(exprStart, end);
				scanRange(exprStart, exprEnd);
				j = exprEnd + 1;
				continue;
			}
			j++;
		}
		return j;
	}

	function recordCall(afterKeyword: number, end: number): number | undefined {
		const open = skipTrivia(afterKeyword, end);
		if (peek(open) !== "(") return undefined;
		const quoteAt = skipTrivia(open + 1, end);
		const str = readString(quoteAt);
		if (str) {
			pushSpecifier(str.value, quoteAt);
			return str.end;
		}
		// `import(`...${...}`)` and `require(`...${...}`)` are not static.
		// Nested calls inside the interpolation are still recorded.
		if (peek(quoteAt) !== "`" || !templateHasSubstitution(quoteAt, end)) {
			return undefined;
		}
		const templateEnd = scanTemplate(quoteAt, end);
		pushSpecifier(source.slice(quoteAt, templateEnd), quoteAt, true);
		return templateEnd;
	}

	function recordDirect(afterKeyword: number, end: number): number | undefined {
		const quoteAt = skipTrivia(afterKeyword, end);
		const str = readString(quoteAt);
		if (!str) return undefined;
		pushSpecifier(str.value, quoteAt);
		return str.end;
	}

	/**
	 * Import declaration or `export ... from`. Stops at `from "..."` or at the
	 * semicolon that ends the statement. Nested `import()` / `require()` at
	 * depth 0 (TypeScript `import x = require("y")`) are recorded too.
	 */
	function captureFrom(afterKeyword: number, end: number): number {
		let j = afterKeyword;
		let depth = 0;
		while (j < end) {
			j = skipTrivia(j, end);
			if (j >= end) return j;
			const c = peek(j);
			if (c === "'" || c === '"') {
				const str = readString(j);
				j = str ? str.end : j + 1;
				continue;
			}
			if (c === "`") {
				j = scanTemplate(j, end);
				continue;
			}
			if (c === "{" || c === "(" || c === "[") {
				depth++;
				j++;
				continue;
			}
			if (c === "}" || c === ")" || c === "]") {
				depth = Math.max(0, depth - 1);
				j++;
				continue;
			}
			if (c === ";" && depth === 0) return j + 1;
			const ident = readIdent(j);
			if (ident && depth === 0 && ident.value === "from") {
				const quoteAt = skipTrivia(ident.end, end);
				const str = readString(quoteAt);
				if (str) {
					pushSpecifier(str.value, quoteAt);
					return str.end;
				}
			}
			if (ident && depth === 0 && ident.value === "require") {
				const called = recordCall(ident.end, end);
				if (called !== undefined) return called;
			}
			if (ident) {
				j = ident.end;
				continue;
			}
			j++;
		}
		return j;
	}

	function isImportDeclaration(afterKeyword: number, end: number): boolean {
		const j = skipTrivia(afterKeyword, end);
		const c = peek(j);
		if (c === '"' || c === "'" || c === "{" || c === "*") return true;
		return readIdent(j) !== undefined;
	}

	function isExportFrom(afterKeyword: number, end: number): boolean {
		const j = skipTrivia(afterKeyword, end);
		const c = peek(j);
		if (c === "{" || c === "*") return true;
		const ident = readIdent(j);
		if (ident?.value !== "type") return false;
		const next = peek(skipTrivia(ident.end, end));
		return next === "{" || next === "*";
	}

	function scanRange(start: number, end: number): void {
		let i = start;
		while (i < end) {
			const c = peek(i);
			if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f") {
				i++;
				continue;
			}
			if (c === "/" && peek(i + 1) === "/") {
				i += 2;
				while (i < end && peek(i) !== "\n") i++;
				continue;
			}
			if (c === "/" && peek(i + 1) === "*") {
				i += 2;
				while (i < end && !(peek(i) === "*" && peek(i + 1) === "/")) i++;
				i = Math.min(end, i + 2);
				continue;
			}
			if (c === '"' || c === "'") {
				const str = readString(i);
				i = str ? str.end : i + 1;
				continue;
			}
			if (c === "`") {
				i = scanTemplate(i, end);
				continue;
			}
			const ident = readIdent(i);
			if (!ident) {
				i++;
				continue;
			}
			i = ident.end;
			if (ident.value === "import" && peek(i) !== ".") {
				const called = recordCall(ident.end, end);
				if (called !== undefined) {
					i = called;
					continue;
				}
				const direct = recordDirect(ident.end, end);
				if (direct !== undefined) {
					i = direct;
					continue;
				}
				if (isImportDeclaration(ident.end, end)) {
					i = captureFrom(ident.end, end);
				}
				continue;
			}
			if (ident.value === "export" && isExportFrom(ident.end, end)) {
				const direct = recordDirect(ident.end, end);
				if (direct !== undefined) {
					i = direct;
					continue;
				}
				i = captureFrom(ident.end, end);
				continue;
			}
			if (ident.value === "require") {
				const called = recordCall(ident.end, end);
				if (called !== undefined) i = called;
			}
		}
	}

	scanRange(0, n);
	found.sort((a, b) => a.index - b.index);
	return found;
}
