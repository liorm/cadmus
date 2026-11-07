import { defineExtension } from "@earendil-works/pi-durable";
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type ReadToolOptions,
} from "@earendil-works/pi-durable/tools";

/**
 * Cadmus coding tools extension (`read`, `write`, `edit`, `bash`).
 * Mutating and shell tools (`write`, `edit`, `bash`) specify `executionMode: "sequential"`
 * so that any round containing them executes in causal call order rather than racing concurrently.
 * Read-only tools (`read`) remain parallel.
 */
export function createCadmusCodingTools(options?: ReadToolOptions) {
	return defineExtension({
		name: "coding-tools",
		tools: [
			createReadTool(options), // Cadmus settings read-only: workspace read.
			{ ...createWriteTool(), executionMode: "sequential" as const },
			{ ...createEditTool(), executionMode: "sequential" as const },
			{ ...createBashTool(), executionMode: "sequential" as const },
		],
	});
}
