/**
 * Capture themed PNGs with Playwright Chromium.
 * UI-flow tests stay on Obscura via scripts/test-ui.ts.
 */
import { spawn } from "node:child_process";

process.env.CADMUS_TEST_ENGINE = "chrome";

const child = spawn(
	"bunx",
	["playwright", "test", "--config=playwright.screens.config.ts"],
	{
		stdio: "inherit",
		env: process.env,
		cwd: new URL("..", import.meta.url).pathname,
	},
);
child.on("exit", (code) => {
	process.exit(code ?? 1);
});
