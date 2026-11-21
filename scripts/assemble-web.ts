/**
 * Assembles the two independent web build artifacts (`@cadmus/login-app` and
 * `@cadmus/web-app`) into the single `./dist/web` directory deployed by
 * Cloudflare Workers Static Assets (`wrangler.jsonc`).
 *
 * Layout:
 *   dist/web/_headers
 *   dist/web/login/index.html
 *   dist/web/login/assets/*
 *   dist/web/app/index.html
 *   dist/web/app/assets/*
 */
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const loginDist = resolve(root, "packages/login-app/dist");
const appDist = resolve(root, "packages/web-app/dist");
const headersSrc = resolve(root, "packages/web-app/public/_headers");
const outDir = resolve(root, "dist/web");

if (!existsSync(resolve(loginDist, "index.html"))) {
	throw new Error(
		"Missing packages/login-app/dist/index.html. Run `bun run login-app:build` first.",
	);
}
if (!existsSync(resolve(appDist, "index.html"))) {
	throw new Error(
		"Missing packages/web-app/dist/index.html. Run `bun run web-app:build` first.",
	);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

cpSync(loginDist, resolve(outDir, "login"), { recursive: true });
cpSync(appDist, resolve(outDir, "app"), { recursive: true });

// Keep a single canonical _headers at the root of the assets directory.
rmSync(resolve(outDir, "app/_headers"), { force: true });
copyFileSync(headersSrc, resolve(outDir, "_headers"));

const loginHtml = readFileSync(resolve(outDir, "login/index.html"), "utf8");
const appHtml = readFileSync(resolve(outDir, "app/index.html"), "utf8");

if (loginHtml.includes("/app/assets/")) {
	throw new Error("Login artifact must not reference /app/assets/");
}
if (!loginHtml.includes("/login/assets/")) {
	throw new Error("Login artifact must load assets from /login/assets/");
}
if (appHtml.includes("/login/assets/")) {
	throw new Error("App artifact must not reference /login/assets/");
}
if (!appHtml.includes("/app/assets/")) {
	throw new Error("App artifact must load assets from /app/assets/");
}

process.stdout.write("Assembled dist/web (login + app).\n");
