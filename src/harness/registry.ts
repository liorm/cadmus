import { createRegistry, type Extension } from "@earendil-works/pi-durable";
import { identityExtension } from "../extensions/identity.ts";

export type RegistryOptions = { home: string; timeZone: string; now?: () => Date };

/**
 * Every extension this process runs, in prompt order. Conversations store extension names, so after a restart the
 * same names must be installed again for pending work to resume. Later phases add memory, skills, scheduler, …
 */
export function buildRegistry(options: RegistryOptions) {
	const registry = createRegistry();
	const extensions: Extension[] = [identityExtension(options)];
	for (const extension of extensions) registry.install(extension);
	return { registry, extensions };
}
