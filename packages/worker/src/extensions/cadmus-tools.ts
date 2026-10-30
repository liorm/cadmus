import type { Extension } from "@earendil-works/pi-durable";
import { scheduleExtension } from "../schedules.js";
import { identityExtension } from "./identity.js";
import { internalToolsExtension } from "./internal-tools.js";
import { knowledgeExtension } from "./knowledge-tools.js";
import { schedulesToolsExtension } from "./schedules-tools.js";
import { tasksToolsExtension } from "./tasks-tools.js";
import { toolGateExtension } from "./tool-gate.js";
import { webToolsExtension } from "./web-tools.js";

/**
 * Cadmus extensions installed on every family harness. Coding tools are
 * installed separately and offered when an enabled tools env resolves and
 * `bot.tools` is omitted or lists a coding tool.
 */
export function cadmusDefaultExtensions(): Extension[] {
	return [
		identityExtension(),
		knowledgeExtension(),
		schedulesToolsExtension(),
		tasksToolsExtension(),
		internalToolsExtension(),
		toolGateExtension(),
		webToolsExtension(),
		scheduleExtension(),
	];
}

/** Tool names offered when `bot.tools` is omitted. */
export function defaultCadmusToolNames(): string[] {
	return cadmusDefaultExtensions().flatMap(
		(ext) => ext.tools?.map((tool) => tool.name) ?? [],
	);
}
