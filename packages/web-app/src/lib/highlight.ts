import type { LanguageFn } from "highlight.js";
import hljs from "highlight.js/lib/core";
import { escapeHtml } from "./markdown";

type Loader = () => Promise<{ default: LanguageFn }>;

const LOADERS: Record<string, Loader> = {
	bash: () => import("highlight.js/lib/languages/bash"),
	css: () => import("highlight.js/lib/languages/css"),
	go: () => import("highlight.js/lib/languages/go"),
	javascript: () => import("highlight.js/lib/languages/javascript"),
	json: () => import("highlight.js/lib/languages/json"),
	markdown: () => import("highlight.js/lib/languages/markdown"),
	python: () => import("highlight.js/lib/languages/python"),
	rust: () => import("highlight.js/lib/languages/rust"),
	sql: () => import("highlight.js/lib/languages/sql"),
	typescript: () => import("highlight.js/lib/languages/typescript"),
	xml: () => import("highlight.js/lib/languages/xml"),
	yaml: () => import("highlight.js/lib/languages/yaml"),
};

const ALIASES: Record<string, string> = {
	js: "javascript",
	jsx: "javascript",
	ts: "typescript",
	tsx: "typescript",
	py: "python",
	sh: "bash",
	shell: "bash",
	yml: "yaml",
	html: "xml",
	md: "markdown",
};

const registered = new Set<string>();
const pending = new Map<string, Promise<void>>();

function resolveLang(lang: string | undefined): string | undefined {
	if (!lang) return undefined;
	const key = lang.trim().toLowerCase();
	return ALIASES[key] ?? (LOADERS[key] ? key : undefined);
}

async function ensureLang(name: string): Promise<void> {
	if (registered.has(name)) return;
	const inflight = pending.get(name);
	if (inflight) return inflight;
	const loader = LOADERS[name];
	if (!loader) return;
	const task = loader()
		.then((mod) => {
			hljs.registerLanguage(name, mod.default);
			registered.add(name);
		})
		.finally(() => {
			pending.delete(name);
		});
	pending.set(name, task);
	await task;
}

export function highlightSync(
	lang: string | undefined,
	code: string,
): string | null {
	const resolved = resolveLang(lang);
	if (!resolved || !hljs.getLanguage(resolved)) return null;
	try {
		return hljs.highlight(code, { language: resolved }).value;
	} catch {
		return escapeHtml(code);
	}
}

export async function highlightCode(
	lang: string | undefined,
	code: string,
): Promise<string> {
	const resolved = resolveLang(lang);
	if (resolved) await ensureLang(resolved);
	return highlightSync(lang, code) ?? escapeHtml(code);
}
