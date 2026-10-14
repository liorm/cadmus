import type { SelfHost } from "./host.ts";
import { selfToolsExtension } from "./host.ts";
import { scheduleTools } from "./schedules.ts";

export type { SelfHost } from "./host.ts";
export { botIdFromCwd } from "./host.ts";
export { parseScheduleCreate, parseScheduleUpdate } from "./schedules.ts";

/** Model tools for this process's own services, scoped to the conversation's bot. */
export function selfExtension(host: SelfHost) {
	return selfToolsExtension(scheduleTools(host));
}
