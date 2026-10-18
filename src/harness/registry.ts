import { createRegistry, type Extension } from "@earendil-works/pi-durable";
import { identityExtension } from "../extensions/identity.ts";
import { internalExtension } from "../extensions/internal/index.ts";
import { knowledgeExtension } from "../extensions/knowledge-tools.ts";
import {
	type SelfHost,
	selfExtension,
} from "../extensions/self-tools/index.ts";
import { toolGateExtension } from "../extensions/tool-gate.ts";
import { webExtension } from "../extensions/web.ts";
import { harvestExtension } from "../harvest/run.ts";
import { scheduleExtension } from "../schedules/task.ts";

export type RegistryOptions = {
	home: string;
	timeZone: string;
	now?: () => Date;
	/** Late-bound services for `pi-bot.self`. Defaults to a host with no services. */
	self?: SelfHost;
};

/**
 * Every extension this process runs, in prompt order. Conversations store extension names, so after a restart the
 * same names must be installed again for pending work to resume.
 */
export function buildRegistry(options: RegistryOptions) {
	const registry = createRegistry();
	const extensions: Extension[] = [
		identityExtension(options),
		knowledgeExtension(),
		webExtension(),
		selfExtension(options.self ?? { home: options.home }),
		internalExtension(options.self ?? { home: options.home }),
		toolGateExtension(options.home),
		scheduleExtension(),
		harvestExtension(),
	];
	for (const extension of extensions) registry.install(extension);
	return { registry, extensions };
}
