import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import type { Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { getLogger } from "../log.ts";

/** pi-durable has no cross-process lock: exactly one process may own a storage. */
export class LockHeld extends Error {
	readonly path: string;
	readonly holder: string;

	constructor(path: string, holder: string) {
		super(
			`Storage is owned by another process (${holder.trim() || "unknown"}); lock: ${path}`,
		);
		this.name = "LockHeld";
		this.path = path;
		this.holder = holder;
	}
}

export type OwnerLock = { readonly path: string; release(): Promise<void> };

/** `bun run dev` (`PI_BOT_DEV=1`): wait for a previous watch process, then signal it if it is still here. */
export const DEV_LOCK_WAIT_MS = 10_000;
const STEAL_GRACE_MS = 3_000;

export type AcquireOwnerLockOptions = {
	/** Wait this long for a live same-host holder to exit before failing (or stealing). */
	readonly waitMs?: number;
	/** After `waitMs`, SIGTERM (then SIGKILL) a still-live same-host holder and take the lock. */
	readonly stealAfterWait?: boolean;
};

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitWhileAlive(pid: number, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (alive(pid) && Date.now() < deadline) {
		await sleep(Math.min(100, deadline - Date.now()));
	}
	return !alive(pid);
}

function signal(pid: number, sig: NodeJS.Signals): void {
	try {
		process.kill(pid, sig);
	} catch {
		// Already gone.
	}
}

/**
 * O_EXCL lock file holding `pid host startedAt`. A dead same-host pid is taken over (kill -9). A live owner, or an
 * owner on another host, is never stolen from — except `bun run dev`, which waits then signals the leftover process
 * so `--watch` can restart.
 */
export async function acquireOwnerLock(
	directory: string,
	options: AcquireOwnerLockOptions = {},
): Promise<OwnerLock> {
	await mkdir(directory, { recursive: true });
	const path = join(directory, "owner.lock");
	const waitMs = Math.max(0, options.waitMs ?? 0);
	const stealAfterWait = Boolean(options.stealAfterWait);
	let waited = false;
	let stole = false;
	for (;;) {
		try {
			const handle = await open(path, "wx");
			await handle.writeFile(
				`${process.pid} ${hostname()} ${new Date().toISOString()}\n`,
			);
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
			const sameHost =
				host === hostname() && Number.isSafeInteger(pid) && pid > 0;
			if (sameHost && !alive(pid)) {
				getLogger().warn(`Removing stale owner.lock of dead pid ${pid}`);
				await unlink(path).catch(() => {});
				continue;
			}
			if (sameHost && waitMs > 0 && !waited) {
				waited = true;
				getLogger().warn(
					`Waiting for owner.lock pid ${pid} to exit (dev restart)`,
				);
				if (await waitWhileAlive(pid, waitMs)) {
					await unlink(path).catch(() => {});
					continue;
				}
			}
			if (sameHost && stealAfterWait && !stole) {
				stole = true;
				getLogger().warn(
					`Signalling leftover owner.lock pid ${pid} so this process can start`,
				);
				signal(pid, "SIGTERM");
				if (!(await waitWhileAlive(pid, STEAL_GRACE_MS))) {
					signal(pid, "SIGKILL");
					await waitWhileAlive(pid, 1_000);
				}
				await unlink(path).catch(() => {});
				continue;
			}
			throw new LockHeld(path, holder);
		}
	}
}

export type OwnedStorage = {
	readonly storage: Storage;
	readonly lock: OwnerLock;
	readonly path: string;
};

/** Lock first, then open `<home>/durable.sqlite` (WAL). Release the lock only after the Harness is closed. */
export async function openOwnedStorage(
	home: string,
	options?: AcquireOwnerLockOptions,
): Promise<OwnedStorage> {
	const lock = await acquireOwnerLock(home, options);
	const path = join(home, "durable.sqlite");
	try {
		return { storage: await openNodeSqliteStorage(path), lock, path };
	} catch (error) {
		await lock.release();
		throw error;
	}
}
