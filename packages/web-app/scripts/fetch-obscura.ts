/**
 * Download a pinned Obscura binary into packages/web-app/.engine/obscura.
 * Used by CI and `test:ui` when the binary is missing.
 */
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const OBSCURA_VERSION = "v0.2.6";

const here = dirname(fileURLToPath(import.meta.url));
const engineDir = resolve(here, "../.engine");
const dest = resolve(engineDir, "obscura");

function archiveName(): string {
	const platform = process.platform;
	const arch = process.arch;
	if (platform === "linux" && arch === "x64") {
		return "obscura-x86_64-linux.tar.gz";
	}
	if (platform === "linux" && arch === "arm64")
		return "obscura-aarch64-linux.tar.gz";
	if (platform === "darwin" && arch === "arm64")
		return "obscura-aarch64-macos.tar.gz";
	if (platform === "darwin" && arch === "x64")
		return "obscura-x86_64-macos.tar.gz";
	throw new Error(`No Obscura archive for ${platform}/${arch}`);
}

export async function ensureObscura(force = false): Promise<string> {
	const named = process.env.CADMUS_TEST_OBSCURA;
	if (named && existsSync(named) && !force) return named;
	if (existsSync(dest) && !force) return dest;

	mkdirSync(engineDir, { recursive: true });
	const archive = archiveName();
	const url = `https://github.com/h4ckf0r0day/obscura/releases/download/${OBSCURA_VERSION}/${archive}`;
	const tarPath = resolve(engineDir, archive);
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(
			`download Obscura ${OBSCURA_VERSION} failed: ${res.status}`,
		);
	}
	await Bun.write(tarPath, res);
	const proc = Bun.spawn(["tar", "xzf", tarPath, "-C", engineDir], {
		stdout: "inherit",
		stderr: "inherit",
	});
	const code = await proc.exited;
	if (code !== 0) throw new Error(`tar extract failed: ${code}`);
	if (!existsSync(dest)) {
		throw new Error(`Obscura binary missing after extract: ${dest}`);
	}
	chmodSync(dest, 0o755);
	return dest;
}

if (import.meta.main) {
	const path = await ensureObscura(process.argv.includes("--force"));
	process.stdout.write(`${path}\n`);
}
