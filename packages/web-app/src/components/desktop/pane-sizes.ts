export const PANE_STORAGE_KEY = "cadmus.cockpit.panes";

export const MIN_PANE_WIDTH = 240;
export const MAX_PANE_WIDTH = 520;
export const DEFAULT_FLEET_WIDTH = 360;
export const DEFAULT_TELEMETRY_WIDTH = 384;

export type PaneSizes = {
	fleet: number;
	telemetry: number;
};

export const DEFAULT_PANE_SIZES: PaneSizes = {
	fleet: DEFAULT_FLEET_WIDTH,
	telemetry: DEFAULT_TELEMETRY_WIDTH,
};

export function clampPaneWidth(value: number): number {
	return Math.min(MAX_PANE_WIDTH, Math.max(MIN_PANE_WIDTH, value));
}

function widthOrDefault(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return clampPaneWidth(value);
}

export function normalizePaneSizes(value: unknown): PaneSizes {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ...DEFAULT_PANE_SIZES };
	}
	const record = value as Record<string, unknown>;
	return {
		fleet: widthOrDefault(record.fleet, DEFAULT_FLEET_WIDTH),
		telemetry: widthOrDefault(record.telemetry, DEFAULT_TELEMETRY_WIDTH),
	};
}

export function readPaneSizes(): PaneSizes {
	if (typeof localStorage === "undefined") return { ...DEFAULT_PANE_SIZES };
	try {
		const raw = localStorage.getItem(PANE_STORAGE_KEY);
		if (raw === null || raw === "") return { ...DEFAULT_PANE_SIZES };
		return normalizePaneSizes(JSON.parse(raw));
	} catch {
		return { ...DEFAULT_PANE_SIZES };
	}
}

export function writePaneSizes(sizes: PaneSizes): void {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(
			PANE_STORAGE_KEY,
			JSON.stringify(normalizePaneSizes(sizes)),
		);
	} catch {
		// Private mode and quota errors should not break the cockpit.
	}
}

export function resetPaneSizes(): PaneSizes {
	return { ...DEFAULT_PANE_SIZES };
}
