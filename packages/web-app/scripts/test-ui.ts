import { spawn } from "node:child_process";
import { ensureObscura } from "./fetch-obscura.ts";

const args = process.argv.slice(2);
const engineArg = args.find((arg) => arg.startsWith("--engine="));
const rest = args.filter((arg) => !arg.startsWith("--engine="));
if (engineArg) {
	process.env.CADMUS_TEST_ENGINE = engineArg.slice("--engine=".length);
}

const engine = (process.env.CADMUS_TEST_ENGINE ?? "obscura").toLowerCase();
if (engine === "obscura") {
	process.env.CADMUS_TEST_OBSCURA = await ensureObscura();
}

const child = spawn("bunx", ["playwright", "test", ...rest], {
	stdio: "inherit",
	env: process.env,
	cwd: new URL("..", import.meta.url).pathname,
});
child.on("exit", (code) => {
	process.exit(code ?? 1);
});
