import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const skip = new Set(["node_modules", "dist", ".git"]);
const needles = ["CADMUS_" + "AUTH_SECRET", "dev-" + "cadmus-secret"];

function walk(dir: string, hits: string[]): void {
	for (const name of readdirSync(dir)) {
		if (skip.has(name)) continue;
		const path = join(dir, name);
		const info = statSync(path);
		if (info.isDirectory()) {
			walk(path, hits);
			continue;
		}
		if (!info.isFile()) continue;
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch {
			continue;
		}
		if (needles.some((needle) => text.includes(needle))) {
			hits.push(relative(repoRoot, path));
		}
	}
}

describe("shared-secret credential is gone", () => {
	it("does not keep the removed credential name or the old dev default", () => {
		const hits: string[] = [];
		walk(repoRoot, hits);
		expect(hits).toEqual([]);
	}, 30_000);
});
