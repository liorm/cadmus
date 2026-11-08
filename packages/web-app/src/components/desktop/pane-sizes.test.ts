import { afterEach, describe, expect, it } from "bun:test";
import {
	DEFAULT_PANE_SIZES,
	MAX_PANE_WIDTH,
	MIN_PANE_WIDTH,
	PANE_STORAGE_KEY,
	readPaneSizes,
	resetPaneSizes,
	writePaneSizes,
} from "./pane-sizes.ts";

type MemoryStorage = {
	getItem: (key: string) => string | null;
	setItem: (key: string, value: string) => void;
	removeItem: (key: string) => void;
	data: Record<string, string>;
};

const originalStorage = Object.getOwnPropertyDescriptor(
	globalThis,
	"localStorage",
);

function installStorage(seed: Record<string, string> = {}): MemoryStorage {
	const data = { ...seed };
	const storage: MemoryStorage = {
		data,
		getItem(key) {
			return Object.hasOwn(data, key) ? (data[key] ?? null) : null;
		},
		setItem(key, value) {
			data[key] = value;
		},
		removeItem(key) {
			delete data[key];
		},
	};
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		writable: true,
		value: storage,
	});
	return storage;
}

afterEach(() => {
	if (originalStorage) {
		Object.defineProperty(globalThis, "localStorage", originalStorage);
		return;
	}
	Reflect.deleteProperty(globalThis, "localStorage");
});

describe("pane sizes", () => {
	it("falls back to defaults when storage is missing", () => {
		installStorage();
		expect(readPaneSizes()).toEqual(DEFAULT_PANE_SIZES);
	});

	it("falls back to defaults when localStorage is undefined", () => {
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			writable: true,
			value: undefined,
		});
		expect(readPaneSizes()).toEqual(DEFAULT_PANE_SIZES);
		writePaneSizes({ fleet: 400, telemetry: 400 });
		expect(readPaneSizes()).toEqual(DEFAULT_PANE_SIZES);
	});

	it("falls back to defaults on invalid JSON", () => {
		installStorage({ [PANE_STORAGE_KEY]: "{not json" });
		expect(readPaneSizes()).toEqual(DEFAULT_PANE_SIZES);
	});

	it("clamps stored widths and keeps in-range values", () => {
		installStorage({
			[PANE_STORAGE_KEY]: JSON.stringify({ fleet: 10, telemetry: 9000 }),
		});
		expect(readPaneSizes()).toEqual({
			fleet: MIN_PANE_WIDTH,
			telemetry: MAX_PANE_WIDTH,
		});

		writePaneSizes({ fleet: 100, telemetry: 400.5 });
		expect(readPaneSizes()).toEqual({
			fleet: MIN_PANE_WIDTH,
			telemetry: 400.5,
		});
	});

	it("uses defaults for non-numeric fields inside valid JSON", () => {
		installStorage({
			[PANE_STORAGE_KEY]: JSON.stringify({
				fleet: "wide",
				telemetry: null,
			}),
		});
		expect(readPaneSizes()).toEqual(DEFAULT_PANE_SIZES);
	});

	it("resetPaneSizes returns defaults without writing", () => {
		const storage = installStorage();
		writePaneSizes({ fleet: 300, telemetry: 420 });
		expect(resetPaneSizes()).toEqual(DEFAULT_PANE_SIZES);
		expect(JSON.parse(storage.data[PANE_STORAGE_KEY] ?? "")).toEqual({
			fleet: 300,
			telemetry: 420,
		});
		expect(readPaneSizes()).toEqual({ fleet: 300, telemetry: 420 });
	});
});
