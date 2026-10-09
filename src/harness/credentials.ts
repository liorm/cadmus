import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

type AuthFile = Record<string, Credential>;

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * pi-ai `CredentialStore` persisted as `auth.json` (same shape as pi's: `{ [providerId]: Credential }`), file mode 0600.
 * The bot and `bun run login` are separate processes, so every `modify` runs under an O_EXCL lock file (`auth.json.lock`)
 * and re-reads the file inside it: a refresh in the bot and a login in the script cannot overwrite each other.
 * pi-ai's `Models.getAuth()` performs OAuth refresh inside `modify`, so a rotated refresh token is stored atomically.
 */
export class FileCredentialStore implements CredentialStore {
	readonly path: string;
	readonly #lockPath: string;
	#chain: Promise<unknown> = Promise.resolve();

	constructor(path: string) {
		this.path = path;
		this.#lockPath = `${path}.lock`;
	}

	static inHome(home: string) {
		return new FileCredentialStore(join(home, "auth.json"));
	}

	async #load(): Promise<AuthFile> {
		try {
			const parsed = JSON.parse(await readFile(this.path, "utf8"));
			return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as AuthFile) : {};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw new Error(`Cannot read credentials file ${this.path}: ${(error as Error).message}`);
		}
	}

	async #save(data: AuthFile) {
		await mkdir(dirname(this.path), { recursive: true });
		const temp = `${this.path}.${process.pid}.tmp`;
		await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
		await rename(temp, this.path);
	}

	async #withFileLock<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		await mkdir(dirname(this.path), { recursive: true });
		const deadline = Date.now() + 30_000;
		for (;;) {
			signal?.throwIfAborted();
			try {
				const handle = await open(this.#lockPath, "wx", 0o600);
				await handle.writeFile(`${process.pid} ${hostname()}\n`);
				await handle.close();
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const [pid, host] = (await readFile(this.#lockPath, "utf8").catch(() => "")).trim().split(/\s+/);
				if (host === hostname() && Number(pid) > 0 && !alive(Number(pid))) {
					await unlink(this.#lockPath).catch(() => {});
					continue;
				}
				if (Date.now() > deadline) throw new Error(`Timed out waiting for ${this.#lockPath}`);
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		}
		try {
			return await work();
		} finally {
			await unlink(this.#lockPath).catch(() => {});
		}
	}

	/** Serialize in-process, then lock across processes. */
	#serial<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const next = this.#chain.then(
			() => this.#withFileLock(work, signal),
			() => this.#withFileLock(work, signal),
		);
		this.#chain = next.catch(() => {});
		return next;
	}

	async read(providerId: string, _options?: AuthOperationOptions): Promise<Credential | undefined> {
		return (await this.#load())[providerId];
	}

	async list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		return Object.entries(await this.#load()).map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.#serial(async () => {
			const data = await this.#load();
			const next = await fn(data[providerId]);
			if (next === undefined) return data[providerId];
			data[providerId] = next;
			await this.#save(data);
			return next;
		}, options?.signal);
	}

	delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		return this.#serial(async () => {
			const data = await this.#load();
			if (!(providerId in data)) return;
			delete data[providerId];
			await this.#save(data);
		}, options?.signal);
	}
}
