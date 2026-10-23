import { mkdirSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

const live = new Map<string, number>();

/** Count live sessions on a cwd. A drop calls release and does not delete the directory. */
export function retainCwd(cwd: string): () => void {
	live.set(cwd, (live.get(cwd) ?? 0) + 1);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const next = (live.get(cwd) ?? 1) - 1;
		if (next <= 0) live.delete(cwd);
		else live.set(cwd, next);
	};
}

export function liveSessions(cwd: string): number {
	return live.get(cwd) ?? 0;
}

/**
 * First construct of a non-persistent workspace empties `.cadmus-ephemeral`.
 * Later sockets in the same process must not call this again.
 */
export function prepareWorkspace(workspace: string, persist: boolean): string {
	if (persist) return workspace;
	const dir = join(workspace, ".cadmus-ephemeral");
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	return dir;
}

export async function deleteEphemeralDir(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true });
}
