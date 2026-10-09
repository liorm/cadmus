import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import type { Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Logger } from "../log.ts";

/** pi-durable has no cross-process lock: exactly one process may own a storage. */
export class LockHeld extends Error {
	readonly path: string;
	readonly holder: string;

	constructor(path: string, holder: string) {
		super(`Storage is owned by another process (${holder.trim() || "unknown"}); lock: ${path}`);
		this.name = "LockHeld";
		this.path = path;
		this.holder = holder;
	}
}

export type OwnerLock = { readonly path: string; release(): Promise<void> };

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * O_EXCL lock file holding `pid host startedAt`. It is only taken over when it names a pid on this host that no longer
 * exists (for example after kill -9); a live owner, or an owner on another host, is never stolen from.
 */
export async function acquireOwnerLock(directory: string, log?: Logger): Promise<OwnerLock> {
	await mkdir(directory, { recursive: true });
	const path = join(directory, "owner.lock");
	for (let attempt = 0; ; attempt++) {
		try {
			const handle = await open(path, "wx");
			await handle.writeFile(`${process.pid} ${hostname()} ${new Date().toISOString()}\n`);
			await handle.sync();
			let released = false;
			return {
				path,
				async release() {
					if (released) return;
					released = true;
					await handle.close();
					await unlink(path).catch(() => {});
				},
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const holder = await readFile(path, "utf8").catch(() => "");
			const [pidText, host] = holder.trim().split(/\s+/);
			const pid = Number(pidText);
			const stale = attempt === 0 && host === hostname() && Number.isSafeInteger(pid) && pid > 0 && !alive(pid);
			if (!stale) throw new LockHeld(path, holder);
			log?.warn(`Removing stale owner.lock of dead pid ${pid}`);
			await unlink(path).catch(() => {});
		}
	}
}

export type OwnedStorage = { readonly storage: Storage; readonly lock: OwnerLock; readonly path: string };

/** Lock first, then open `<home>/durable.sqlite` (WAL). Release the lock only after the Harness is closed. */
export async function openOwnedStorage(home: string, log?: Logger): Promise<OwnedStorage> {
	const lock = await acquireOwnerLock(home, log);
	const path = join(home, "durable.sqlite");
	try {
		return { storage: await openNodeSqliteStorage(path), lock, path };
	} catch (error) {
		await lock.release();
		throw error;
	}
}
