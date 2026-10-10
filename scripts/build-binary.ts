// Self-contained executables: Bun runtime, server bundle, and the prebuilt web UI.
// `bun start` does not use this; it still bundles the page at listen time.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const targets = [
	["bun-darwin-x64", "pi-bot-darwin-x64"],
	["bun-darwin-arm64", "pi-bot-darwin-arm64"],
	["bun-linux-arm64", "pi-bot-linux-arm64"],
] as const;

const ui = await Bun.build({
	entrypoints: [join(root, "src/channels/web/ui/main.tsx")],
	target: "browser",
	format: "esm",
	tsconfig: join(root, "tsconfig.web.json"),
	jsx: { runtime: "automatic", importSource: "preact", development: false },
});
if (!ui.success) {
	throw new Error(
		ui.logs.map((log) => log.message).join("\n") || "web bundle failed",
	);
}
let js = "";
let css = "";
for (const output of ui.outputs) {
	if (output.path.endsWith(".css")) css = await output.text();
	else if (output.path.endsWith(".js")) js += await output.text();
}
if (!js) throw new Error("web bundle produced no script");

const outdir = join(root, "dist");
await mkdir(outdir, { recursive: true });

for (const [target, name] of targets) {
	const outfile = join(outdir, name);
	const built = await Bun.build({
		entrypoints: [join(root, "src/main.ts")],
		define: {
			PI_BOT_EMBEDDED_UI: JSON.stringify({ js, css }),
		},
		compile: {
			target,
			outfile,
		},
	});
	if (!built.success) {
		throw new Error(
			built.logs.map((log) => log.message).join("\n") ||
				`binary build failed for ${target}`,
		);
	}
	console.log(`${target} → ${outfile}`);
}
