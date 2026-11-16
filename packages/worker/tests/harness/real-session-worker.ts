/**
 * Test-only entry for `wrangler dev`, used only by the explicit real-session
 * harness runs (see `playwright-shared.ts`). It serves the production worker
 * and its Durable Object classes unchanged, and answers the typed harness
 * operations first. The deployed worker (`wrangler.jsonc` `main`) never
 * imports this file.
 */
import worker from "../../src/index.js";
import { type HarnessEnv, handleHarness } from "./real-session-harness.js";

export * from "../../src/index.js";

export default {
	async fetch(
		request: Request,
		env: HarnessEnv,
		ctx: ExecutionContext,
	): Promise<Response> {
		return (
			(await handleHarness(request, env)) ?? worker.fetch(request, env, ctx)
		);
	},
} satisfies ExportedHandler<HarnessEnv>;
