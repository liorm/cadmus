export const THEME_STORAGE_KEY = "cadmus.theme";
export const THEMES = ["dark", "light", "sepia"] as const;
export type ThemeName = (typeof THEMES)[number];

export function isThemeName(value: unknown): value is ThemeName {
	return value === "dark" || value === "light" || value === "sepia";
}

/** localStorage is the source of truth. Missing or invalid storage is null, not "dark". */
export function getStoredTheme(): ThemeName | null {
	if (typeof localStorage === "undefined") return null;
	try {
		const stored = localStorage.getItem(THEME_STORAGE_KEY);
		if (isThemeName(stored)) return stored;
	} catch {
		return null;
	}
	return null;
}

export function getTheme(): ThemeName {
	const stored = getStoredTheme();
	if (stored) return stored;
	if (typeof document !== "undefined") {
		const attr = document.documentElement.getAttribute("data-theme");
		if (isThemeName(attr)) return attr;
	}
	return "dark";
}

export function setTheme(theme: ThemeName): void {
	const next: ThemeName = isThemeName(theme) ? theme : "dark";
	if (typeof document !== "undefined") {
		document.documentElement.setAttribute("data-theme", next);
	}
	try {
		localStorage.setItem(THEME_STORAGE_KEY, next);
	} catch {
		/* private mode */
	}
}

export function applyStoredTheme(): ThemeName {
	const theme = getStoredTheme() ?? "dark";
	setTheme(theme);
	return theme;
}
