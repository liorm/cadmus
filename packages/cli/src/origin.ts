/** Public production Worker. Matches `CADMUS_PUBLIC_URL` in wrangler.jsonc. */
export const PRODUCTION_ORIGIN = "https://cadmus.purelogicstudios.com";

export const DEV_ORIGIN = "http://localhost:8787";

/**
 * `bun build --compile` embeds the module at `file:///$bunfs/...`.
 * `bun run cli` keeps a real filesystem URL. `NODE_ENV` is not the signal:
 * compile without `--production` hardcodes it to `"development"`.
 * `--url` and `CADMUS_URL` still win.
 */
export function isCompiledCli(moduleUrl: string = import.meta.url): boolean {
	return moduleUrl.includes("$bunfs");
}

export function defaultOrigin(moduleUrl?: string): string {
	return isCompiledCli(moduleUrl) ? PRODUCTION_ORIGIN : DEV_ORIGIN;
}
