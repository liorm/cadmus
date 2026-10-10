import { signal } from "@preact/signals";

export const THEMES = ["light", "dark", "fire"] as const;
export type Theme = (typeof THEMES)[number];

const KEY = "pi-bot.theme";

export function parseTheme(value: string | null): Theme {
	if (value === "light" || value === "dark" || value === "fire") return value;
	return "dark";
}

export const theme = signal<Theme>(readTheme());

export function readTheme(): Theme {
	try {
		return parseTheme(localStorage.getItem(KEY));
	} catch {
		return "dark";
	}
}

export function setTheme(next: Theme): void {
	theme.value = next;
	document.documentElement.dataset.theme = next;
	try {
		localStorage.setItem(KEY, next);
	} catch {
		// Private mode can reject storage. The attribute still applies.
	}
}

export function themeLabel(id: Theme): string {
	if (id === "light") return "Light";
	if (id === "fire") return "Fire";
	return "Dark";
}
