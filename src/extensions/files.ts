import { defineExtension } from "@earendil-works/pi-durable";
import { createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";

/**
 * `read`, `write`, and `edit` on their own. `CodingTools` also installs bash, which this bot does not have.
 * `write` and `edit` keep the library replay default (`unsafe`): recovery runs them again.
 * Frontmatter is a prompt rule, not a check in these tools.
 */
export function filesExtension() {
	return defineExtension({
		name: "pi-bot.files",
		tools: [createReadTool(), createWriteTool(), createEditTool()],
	});
}
