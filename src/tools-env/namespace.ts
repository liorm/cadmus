import { LineScanner } from "@earendil-works/pi-durable/env";
import {
	Bash,
	type BashExecResult,
	type IFileSystem,
	InMemoryFs,
} from "just-bash";
import {
	baseName,
	NAMESPACE_BYTE_CAP,
	parentPath,
	resolveWorkspacePath,
	shellQuote,
	WORKSPACE_ROOT,
} from "./pure.js";

export interface OpError {
	code: string;
	message: string;
	path?: string;
}

export type OpResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: OpError };

export interface FileInfoPlain {
	name: string;
	path: string;
	kind: "file" | "directory" | "symlink";
	size: number;
	mtimeMs: number;
}

export interface FsSnapshotRow {
	path: string;
	kind: "file" | "dir" | "symlink";
	content: Uint8Array | null;
}

export type WatchEvent =
	| { paths: string[] }
	| { overflow: true }
	| { error: OpError };

interface WatchTargetNorm {
	path: string;
	recursive: boolean;
	hidden: boolean;
	names: string[];
}

interface WatchReg {
	id: string;
	targets: WatchTargetNorm[];
	closed: boolean;
	buffer: WatchEvent[];
	listeners: Set<(event: WatchEvent) => void>;
}

type ReaderState =
	| {
			kind: "binary";
			identity?: string;
			snapshot: Uint8Array;
			info: FileInfoPlain;
			closed: boolean;
	  }
	| {
			kind: "dir";
			path: string;
			yielded: Set<string>;
			closed: boolean;
	  }
	| {
			kind: "lines";
			lines: { text: string; terminated: boolean }[];
			index: number;
			closed: boolean;
	  };

class CapError extends Error {
	constructor() {
		super("ENOSPC: namespace byte limit exceeded");
		this.name = "CapError";
	}
}

function ok<T>(value: T): OpResult<T> {
	return { ok: true, value };
}

function fail<T>(error: OpError): OpResult<T> {
	return { ok: false, error };
}

function toBytes(content: string | Uint8Array | ArrayBuffer): Uint8Array {
	if (typeof content === "string") return new TextEncoder().encode(content);
	if (content instanceof Uint8Array) return content;
	if (content instanceof ArrayBuffer) return new Uint8Array(content);
	return new Uint8Array(content as ArrayBuffer);
}

function mapError(error: unknown, path?: string): OpError {
	if (error instanceof CapError) {
		return { code: "invalid", message: error.message, path };
	}
	const message = error instanceof Error ? error.message : String(error);
	let code = "unknown";
	if (message.startsWith("ENOENT")) code = "not_found";
	else if (message.startsWith("EISDIR")) code = "is_directory";
	else if (message.startsWith("ENOTDIR")) code = "not_directory";
	else if (
		message.startsWith("ENOSPC") ||
		message.includes("byte limit") ||
		message.startsWith("EINVAL") ||
		message.startsWith("EEXIST")
	) {
		code = "invalid";
	} else if (message.startsWith("EPERM") || message.startsWith("EACCES")) {
		code = "permission_denied";
	}
	return { code, message, path };
}

function normalizeAbs(path: string): string {
	const parts: string[] = [];
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			parts.pop();
			continue;
		}
		parts.push(part);
	}
	return `/${parts.join("/")}`;
}

/**
 * One just-bash VFS. Baseline layout bytes are not counted toward the 8 MiB cap.
 * User file bytes are counted in memory and, when persist is on, mirrored to SQLite.
 */
export class JustBashNamespace {
	readonly cwd = WORKSPACE_ROOT;
	readonly raw: InMemoryFs;
	readonly bash: Bash;
	readonly fs: IFileSystem;
	persist: boolean;
	botId: string | undefined;
	private booting = true;
	private replaying = false;
	private baseline = new Set<string>();
	private baselineBytes = new Map<string, number>();
	private userBytes = new Map<string, number>();
	private links = new Map<string, string>();
	private readers = new Map<string, ReaderState>();
	private watches = new Map<string, WatchReg>();
	private aborts = new Map<string, AbortController>();
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private watchSig = new Map<string, string>();
	private onPersist?: (
		row: FsSnapshotRow | { path: string; deleted: true },
	) => void;
	private onMutate: (paths: string[]) => void = () => {};

	private constructor(persist: boolean) {
		this.persist = persist;
		this.raw = new InMemoryFs();
		this.fs = this.wrap(this.raw);
		// Use "hardened" execution limit profile.
		// In addition to tight compute/memory bounds suited for Durable Object isolates,
		// "hardened" sets maxOutputSize to 10 MiB (down from normal 256 MiB).
		// In Cloudflare Workers (workerd), node:zlib enforces that options.maxOutputLength
		// cannot exceed 128 MiB (134,217,728 bytes). With the default 256 MiB maxOutputSize,
		// just-bash's gzip/gunzip/zcat fails immediately with:
		//   RangeError: The value of "options.maxOutputLength" is out of range. It must be >= 1 and <= 134217728. Received 268435456
		// The 10 MiB limit in "hardened" safely satisfies workerd's zlib cap while remaining
		// well-aligned with our 8 MiB NAMESPACE_BYTE_CAP.
		this.bash = new Bash({
			fs: this.fs,
			cwd: WORKSPACE_ROOT,
			defenseInDepth: false,
			executionLimitProfile: "hardened",
		});
	}

	static async create(options: {
		persist: boolean;
		botId?: string;
		rows?: FsSnapshotRow[];
		onPersist?: (row: FsSnapshotRow | { path: string; deleted: true }) => void;
	}): Promise<JustBashNamespace> {
		const ns = new JustBashNamespace(options.persist);
		ns.botId = options.botId;
		ns.onPersist = options.onPersist;
		await ns.markBaseline();
		if (options.rows && options.rows.length > 0) {
			ns.replaying = true;
			const rows = [...options.rows].sort(
				(a, b) => a.path.length - b.path.length,
			);
			for (const row of rows) {
				if (row.kind === "dir") {
					ns.wrappedMkdirSync(row.path);
				} else if (row.kind === "symlink") {
					const target = new TextDecoder().decode(
						row.content ?? new Uint8Array(),
					);
					await ns.wrappedSymlink(target, row.path);
				} else {
					ns.wrappedWriteSync(row.path, row.content ?? new Uint8Array());
				}
			}
			ns.replaying = false;
		}
		return ns;
	}

	setPersistHandler(
		handler: (row: FsSnapshotRow | { path: string; deleted: true }) => void,
	): void {
		this.onPersist = handler;
	}

	setMutateHandler(handler: (paths: string[]) => void): void {
		this.onMutate = handler;
	}

	countedBytes(): number {
		let total = 0;
		for (const size of this.userBytes.values()) total += size;
		return total;
	}

	private async markBaseline(): Promise<void> {
		this.baseline = new Set(this.raw.getAllPaths());
		this.baselineBytes = new Map();
		for (const path of this.baseline) {
			try {
				const stat = await this.raw.lstat(path);
				if (stat.isFile) this.baselineBytes.set(path, stat.size);
			} catch {
				// Layout entries can disappear; they simply are not counted.
			}
		}
		this.booting = false;
	}

	private total(): number {
		return this.countedBytes();
	}

	private reserve(path: string, nextSize: number): void {
		if (this.booting) return;
		const prev = this.userBytes.get(path) ?? 0;
		if (
			!this.replaying &&
			this.total() - prev + nextSize > NAMESPACE_BYTE_CAP
		) {
			throw new CapError();
		}
		if (nextSize === 0 && !this.userBytes.has(path)) return;
		this.userBytes.set(path, nextSize);
	}

	private snapshotBytes(path: string): number | undefined {
		return this.userBytes.has(path) ? this.userBytes.get(path) : undefined;
	}

	private restoreBytes(path: string, prev: number | undefined): void {
		if (prev === undefined) this.userBytes.delete(path);
		else this.userBytes.set(path, prev);
	}

	private forgetTree(path: string): void {
		const prefix = path.endsWith("/") ? path : `${path}/`;
		for (const key of [...this.userBytes.keys()]) {
			if (key === path || key.startsWith(prefix)) this.userBytes.delete(key);
		}
		for (const key of [...this.links.keys()]) {
			if (key === path || key.startsWith(prefix)) this.links.delete(key);
		}
	}

	private note(paths: string[]): void {
		if (this.booting || this.replaying || paths.length === 0) return;
		this.onMutate(paths);
	}

	private persistRow(row: FsSnapshotRow): void {
		if (this.booting || this.replaying || !this.persist) return;
		this.onPersist?.(row);
	}

	private persistDelete(path: string): void {
		if (this.booting || this.replaying || !this.persist) return;
		this.onPersist?.({ path, deleted: true });
	}

	private ensureParentsSync(path: string): void {
		const parent = parentPath(path);
		if (parent === "/" || parent === path) return;
		try {
			this.raw.mkdirSync(parent, { recursive: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			if (!message.startsWith("EEXIST")) throw error;
		}
	}

	private wrappedWriteSync(path: string, content: Uint8Array): void {
		this.ensureParentsSync(path);
		const prev = this.snapshotBytes(path);
		this.reserve(path, content.byteLength);
		try {
			this.raw.writeFileSync(path, content);
		} catch (error) {
			this.restoreBytes(path, prev);
			throw error;
		}
		this.links.delete(path);
		this.persistRow({ path, kind: "file", content });
		this.note([path]);
	}

	private async wrappedWrite(
		path: string,
		content: string | Uint8Array,
	): Promise<void> {
		this.wrappedWriteSync(path, toBytes(content));
	}

	private async wrappedAppend(
		path: string,
		content: string | Uint8Array,
	): Promise<void> {
		const extra = toBytes(content);
		let prev = new Uint8Array();
		try {
			const read = await this.raw.readFileBuffer(path);
			prev = new Uint8Array(read.byteLength);
			prev.set(read);
		} catch {
			prev = new Uint8Array();
		}
		const next = new Uint8Array(prev.byteLength + extra.byteLength);
		next.set(prev, 0);
		next.set(extra, prev.byteLength);
		this.wrappedWriteSync(path, next);
	}

	private wrappedMkdirSync(path: string): void {
		try {
			this.raw.mkdirSync(path, { recursive: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			if (!message.startsWith("EEXIST")) throw error;
		}
		this.userBytes.delete(path);
		this.persistRow({ path, kind: "dir", content: null });
		this.note([path]);
	}

	private async wrappedRm(
		path: string,
		options?: { recursive?: boolean; force?: boolean },
	): Promise<void> {
		const prefix = path.endsWith("/") ? path : `${path}/`;
		const removed = this.raw
			.getAllPaths()
			.filter((entry) => entry === path || entry.startsWith(prefix));
		try {
			await this.raw.rm(path, options);
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			if (options?.force && message.startsWith("ENOENT")) {
				this.forgetTree(path);
				return;
			}
			throw error;
		}
		this.forgetTree(path);
		for (const entry of removed) this.persistDelete(entry);
		this.note(removed.length > 0 ? removed : [path]);
	}

	private async wrappedCp(
		source: string,
		dest: string,
		options?: { recursive?: boolean },
	): Promise<void> {
		let size = 0;
		try {
			const stat = await this.raw.lstat(source);
			if (stat.isFile) {
				size = this.userBytes.get(source) ?? stat.size;
			}
		} catch {
			size = this.userBytes.get(source) ?? 0;
		}
		const prev = this.snapshotBytes(dest);
		this.reserve(dest, size);
		try {
			await this.raw.cp(source, dest, options);
		} catch (error) {
			this.restoreBytes(dest, prev);
			throw error;
		}
		if (size > 0) {
			const bytes = await this.raw.readFileBuffer(dest);
			this.persistRow({ path: dest, kind: "file", content: bytes });
		} else {
			this.persistRow({ path: dest, kind: "dir", content: null });
		}
		this.note([dest]);
	}

	private async wrappedMv(source: string, dest: string): Promise<void> {
		const prefix = source.endsWith("/") ? source : `${source}/`;
		const moved = [...this.userBytes.keys()].filter(
			(key) => key === source || key.startsWith(prefix),
		);
		await this.raw.mv(source, dest);
		for (const key of moved) {
			const size = this.userBytes.get(key) ?? 0;
			this.userBytes.delete(key);
			const relocated =
				key === source ? dest : `${dest}${key.slice(source.length)}`;
			this.userBytes.set(relocated, size);
		}
		if (this.links.has(source)) {
			const target = this.links.get(source);
			this.links.delete(source);
			if (target) this.links.set(dest, target);
		}
		this.persistDelete(source);
		try {
			const stat = await this.raw.lstat(dest);
			if (stat.isSymbolicLink) {
				const target = await this.raw.readlink(dest);
				this.links.set(dest, normalizeAbs(`${parentPath(dest)}/${target}`));
				this.persistRow({
					path: dest,
					kind: "symlink",
					content: new TextEncoder().encode(target),
				});
			} else if (stat.isFile) {
				const bytes = await this.raw.readFileBuffer(dest);
				this.userBytes.set(dest, bytes.byteLength);
				this.persistRow({ path: dest, kind: "file", content: bytes });
			} else if (stat.isDirectory) {
				this.persistRow({ path: dest, kind: "dir", content: null });
			}
		} catch {
			// Destination stat can fail if mv removed a link; the delete already persisted.
		}
		this.note([source, dest]);
	}

	private async wrappedSymlink(
		target: string,
		linkPath: string,
	): Promise<void> {
		this.ensureParentsSync(linkPath);
		await this.raw.symlink(target, linkPath);
		const absolute = target.startsWith("/")
			? normalizeAbs(target)
			: normalizeAbs(`${parentPath(linkPath)}/${target}`);
		this.links.set(linkPath, absolute);
		this.userBytes.set(linkPath, 0);
		this.persistRow({
			path: linkPath,
			kind: "symlink",
			content: new TextEncoder().encode(target),
		});
		this.note([linkPath]);
	}

	private async wrappedLink(existing: string, next: string): Promise<void> {
		const stat = await this.raw.lstat(existing);
		const prev = this.snapshotBytes(next);
		this.reserve(next, stat.size);
		try {
			await this.raw.link(existing, next);
		} catch (error) {
			this.restoreBytes(next, prev);
			throw error;
		}
		const bytes = await this.raw.readFileBuffer(next);
		this.persistRow({ path: next, kind: "file", content: bytes });
		this.note([next]);
	}

	private wrap(raw: InMemoryFs): IFileSystem {
		const self = this;
		return new Proxy(raw, {
			get(target, prop, receiver) {
				if (prop === "writeFile") {
					return (path: string, content: string | Uint8Array) =>
						self.wrappedWrite(path, content);
				}
				if (prop === "writeFileSync") {
					return (path: string, content: string | Uint8Array) =>
						self.wrappedWriteSync(path, toBytes(content));
				}
				if (prop === "appendFile") {
					return (path: string, content: string | Uint8Array) =>
						self.wrappedAppend(path, content);
				}
				if (prop === "mkdir" || prop === "mkdirSync") {
					return (path: string) => {
						self.wrappedMkdirSync(path);
						return Promise.resolve();
					};
				}
				if (prop === "rm") {
					return (
						path: string,
						options?: { recursive?: boolean; force?: boolean },
					) => self.wrappedRm(path, options);
				}
				if (prop === "cp") {
					return (
						source: string,
						dest: string,
						options?: { recursive?: boolean },
					) => self.wrappedCp(source, dest, options);
				}
				if (prop === "mv") {
					return (source: string, dest: string) => self.wrappedMv(source, dest);
				}
				if (prop === "symlink") {
					return (target: string, linkPath: string) =>
						self.wrappedSymlink(target, linkPath);
				}
				if (prop === "link") {
					return (existing: string, next: string) =>
						self.wrappedLink(existing, next);
				}
				const value = Reflect.get(target, prop, receiver);
				if (typeof value === "function") {
					return (value as (...args: unknown[]) => unknown).bind(target);
				}
				return value;
			},
		}) as IFileSystem;
	}

	private jail(
		input: string,
	): { ok: true; path: string } | { ok: false; error: OpError } {
		const resolved = resolveWorkspacePath(input, this.cwd);
		if (!resolved.ok) {
			return {
				ok: false,
				error: { code: "invalid", message: resolved.message, path: input },
			};
		}
		return { ok: true, path: resolved.path };
	}

	private async infoAt(path: string, follow: boolean): Promise<FileInfoPlain> {
		const stat = follow
			? await this.raw.stat(path)
			: await this.raw.lstat(path);
		const kind = stat.isSymbolicLink
			? "symlink"
			: stat.isDirectory
				? "directory"
				: "file";
		return {
			name: baseName(path),
			path,
			kind,
			size: stat.size,
			mtimeMs: stat.mtime instanceof Date ? stat.mtime.getTime() : Date.now(),
		};
	}

	absolutePath(input: string): OpResult<string> {
		const jailed = this.jail(input);
		if (!jailed.ok) return jailed;
		return ok(jailed.path);
	}

	joinPath(parts: readonly string[]): OpResult<string> {
		let current = this.cwd;
		for (const part of parts) {
			current = part.startsWith("/")
				? part
				: `${current.endsWith("/") ? current.slice(0, -1) : current}/${part}`;
		}
		return this.absolutePath(current);
	}

	async readTextFile(input: string): Promise<OpResult<string>> {
		const jailed = this.jail(input);
		if (!jailed.ok) return jailed;
		try {
			const stat = await this.raw.stat(jailed.path);
			if (stat.isDirectory) {
				return fail({
					code: "is_directory",
					message: "EISDIR: is a directory",
					path: jailed.path,
				});
			}
			const text = await this.raw.readFile(jailed.path);
			return ok(text);
		} catch (error) {
			return fail(mapError(error, jailed.path));
		}
	}

	async readBinaryFile(input: string): Promise<OpResult<Uint8Array>> {
		const jailed = this.jail(input);
		if (!jailed.ok) return jailed;
		try {
			const stat = await this.raw.stat(jailed.path);
			if (stat.isDirectory) {
				return fail({
					code: "is_directory",
					message: "EISDIR: is a directory",
					path: jailed.path,
				});
			}
			return ok(await this.raw.readFileBuffer(jailed.path));
		} catch (error) {
			return fail(mapError(error, jailed.path));
		}
	}

	async readTextLines(
		input: string,
		maxLines: number | undefined,
	): Promise<OpResult<string[]>> {
		const text = await this.readTextFile(input);
		if (!text.ok) return text;
		if (text.value === "") return ok([]);
		const parts = text.value.split("\n");
		if (text.value.endsWith("\n")) parts.pop();
		return ok(
			maxLines !== undefined && maxLines >= 0
				? parts.slice(0, maxLines)
				: parts,
		);
	}

	openTextLineReader(input: string): Promise<OpResult<string>> {
		return this.readTextFile(input).then((text) => {
			if (!text.ok) return text;
			const id = crypto.randomUUID();
			if (text.value === "") {
				this.readers.set(id, {
					kind: "lines",
					lines: [],
					index: 0,
					closed: false,
				});
				return ok(id);
			}
			const rawLines = text.value.split("\n");
			const ended = text.value.endsWith("\n");
			const lines = rawLines.map((line, index) => ({
				text: line,
				terminated: index < rawLines.length - 1 || ended,
			}));
			if (ended) lines.pop();
			this.readers.set(id, { kind: "lines", lines, index: 0, closed: false });
			return ok(id);
		});
	}

	readLine(id: string): OpResult<{ text: string; terminated: boolean } | null> {
		const reader = this.readers.get(id);
		if (reader?.kind !== "lines") {
			return fail({ code: "invalid", message: "reader is closed" });
		}
		if (reader.closed)
			return fail({ code: "invalid", message: "reader is closed" });
		const line = reader.lines[reader.index];
		if (!line) return ok(null);
		reader.index += 1;
		return ok(line);
	}

	async openBinaryReader(
		input: string,
		noFollow: boolean,
	): Promise<OpResult<{ id: string; info: FileInfoPlain }>> {
		const jailed = this.jail(input);
		if (!jailed.ok) return jailed;
		try {
			let path = jailed.path;
			if (noFollow) {
				const parent = parentPath(path);
				const base = baseName(path);
				const parentReal =
					parent === WORKSPACE_ROOT ? parent : await this.raw.realpath(parent);
				if (
					parentReal !== WORKSPACE_ROOT &&
					!parentReal.startsWith(`${WORKSPACE_ROOT}/`)
				) {
					return fail({
						code: "permission_denied",
						message: "path escapes /workspace",
						path: input,
					});
				}
				path = `${parentReal}/${base}`;
				const lst = await this.raw.lstat(path);
				if (lst.isSymbolicLink) {
					return fail({
						code: "invalid",
						message: "refusing to follow the final symbolic link",
						path,
					});
				}
				if (lst.isDirectory) {
					return fail({
						code: "is_directory",
						message: "EISDIR: is a directory",
						path,
					});
				}
				if (!lst.isFile) {
					return fail({ code: "invalid", message: "not a regular file", path });
				}
			} else {
				const stat = await this.raw.stat(path);
				if (stat.isDirectory) {
					return fail({
						code: "is_directory",
						message: "EISDIR: is a directory",
						path,
					});
				}
				if (!stat.isFile) {
					return fail({ code: "invalid", message: "not a regular file", path });
				}
			}
			const lst = await this.raw.lstat(path);
			const bytes = await this.raw.readFileBuffer(path);
			const info = await this.infoAt(path, false);
			const id = crypto.randomUUID();
			this.readers.set(id, {
				kind: "binary",
				identity: lst.identity,
				snapshot: bytes,
				info,
				closed: false,
			});
			return ok({ id, info });
		} catch (error) {
			return fail(mapError(error, jailed.path));
		}
	}

	private async bytesForReader(
		reader: Extract<ReaderState, { kind: "binary" }>,
	): Promise<Uint8Array> {
		if (reader.identity) {
			try {
				const stat = await this.raw.lstat(reader.info.path);
				if (stat.identity === reader.identity && stat.isFile) {
					return await this.raw.readFileBuffer(reader.info.path);
				}
			} catch {
				// Path moved or vanished; fall through to a full scan.
			}
			for (const path of this.raw.getAllPaths()) {
				try {
					const stat = await this.raw.lstat(path);
					if (stat.identity === reader.identity && stat.isFile) {
						return await this.raw.readFileBuffer(path);
					}
				} catch {
					// The path vanished between listing and stat.
				}
			}
		}
		return reader.snapshot;
	}

	async binaryInfo(id: string): Promise<OpResult<FileInfoPlain>> {
		const reader = this.readers.get(id);
		if (reader?.kind !== "binary" || reader.closed) {
			return fail({ code: "invalid", message: "reader is closed" });
		}
		if (reader.identity) {
			try {
				const stat = await this.raw.lstat(reader.info.path);
				if (stat.identity === reader.identity && stat.isFile) {
					return ok(await this.infoAt(reader.info.path, false));
				}
			} catch {
				// Path moved or vanished; fall through to a full scan.
			}
			for (const path of this.raw.getAllPaths()) {
				try {
					const stat = await this.raw.lstat(path);
					if (stat.identity === reader.identity && stat.isFile) {
						return ok(await this.infoAt(path, false));
					}
				} catch {
					// Keep looking.
				}
			}
		}
		return ok(reader.info);
	}

	async binaryRead(
		id: string,
		offset: number,
		length: number,
	): Promise<OpResult<Uint8Array>> {
		const reader = this.readers.get(id);
		if (reader?.kind !== "binary" || reader.closed) {
			return fail({ code: "invalid", message: "reader is closed" });
		}
		if (
			!Number.isInteger(offset) ||
			!Number.isInteger(length) ||
			offset < 0 ||
			length < 0
		) {
			return fail({
				code: "invalid",
				message: "offset and length must be non-negative integers",
			});
		}
		const bytes = await this.bytesForReader(reader);
		if (offset >= bytes.byteLength) return ok(new Uint8Array());
		return ok(bytes.slice(offset, Math.min(bytes.byteLength, offset + length)));
	}

	async binaryScan(
		id: string,
		startLine: number,
		endLine: number | undefined,
	): Promise<OpResult<ReturnType<LineScanner["finish"]>>> {
		const reader = this.readers.get(id);
		if (reader?.kind !== "binary" || reader.closed) {
			return fail({ code: "invalid", message: "reader is closed" });
		}
		if (
			!Number.isInteger(startLine) ||
			startLine < 0 ||
			(endLine !== undefined &&
				(!Number.isInteger(endLine) || endLine <= startLine))
		) {
			return fail({ code: "invalid", message: "line range is invalid" });
		}
		try {
			const scanner = new LineScanner(startLine, endLine);
			const bytes = await this.bytesForReader(reader);
			scanner.push(bytes);
			return ok(scanner.finish());
		} catch (error) {
			return fail(mapError(error));
		}
	}

	closeReader(id: string): void {
		const reader = this.readers.get(id);
		if (!reader) return;
		reader.closed = true;
		this.readers.delete(id);
	}

	async writeFile(
		input: string,
		content: string | Uint8Array,
	): Promise<OpResult<null>> {
		const jailed = this.jail(input);
		if (!jailed.ok) return jailed;
		try {
			this.wrappedWriteSync(jailed.path, toBytes(content));
			return ok(null);
		} catch (error) {
			return fail(mapError(error, jailed.path));
		}
	}

	async appendFile(
		input: string,
		content: string | Uint8Array,
	): Promise<OpResult<null>> {
		const jailed = this.jail(input);
		if (!jailed.ok) return jailed;
		try {
			await this.wrappedAppend(jailed.path, content);
			return ok(null);
		} catch (error) {
			return fail(mapError(error, jailed.path));
		}
	}

	async truncateFile(input: string, size: number): Promise<OpResult<null>> {
		const jailed = this.jail(input);
		if (!jailed.ok) return jailed;
		if (!Number.isInteger(size) || size < 0) {
			return fail({
				code: "invalid",
				message: "size must be a non-negative integer",
				path: jailed.path,
			});
		}
		try {
			const current = await this.raw.readFileBuffer(jailed.path);
			const next = new Uint8Array(size);
			next.set(current.subarray(0, Math.min(size, current.byteLength)));
			this.wrappedWriteSync(jailed.path, next);
			return ok(null);
		} catch (error) {
			return fail(mapError(error, jailed.path));
		}
	}

	async renameFile(source: string, dest: string): Promise<OpResult<null>> {
		const from = this.jail(source);
		if (!from.ok) return from;
		const to = this.jail(dest);
		if (!to.ok) return to;
		try {
			await this.wrappedMv(from.path, to.path);
			return ok(null);
		} catch (error) {
			return fail(mapError(error, from.path));
		}
	}

	async fileInfo(input: string): Promise<OpResult<FileInfoPlain>> {
		const jailed = this.jail(input);
		if (!jailed.ok) return jailed;
		try {
			return ok(await this.infoAt(jailed.path, false));
		} catch (error) {
			return fail(mapError(error, jailed.path));
		}
	}

	async listDir(input: string): Promise<OpResult<FileInfoPlain[]>> {
		const jailed = this.jail(input);
		if (!jailed.ok) return jailed;
		try {
			const names = await this.raw.readdir(jailed.path);
			const entries: FileInfoPlain[] = [];
			for (const name of names) {
				const path =
					jailed.path === "/" ? `/${name}` : `${jailed.path}/${name}`;
				try {
					entries.push(await this.infoAt(path, false));
				} catch {
					// Disappeared between readdir and lstat.
				}
			}
			return ok(entries);
		} catch (error) {
			return fail(mapError(error, jailed.path));
		}
	}

	openDirReader(input: string): Promise<OpResult<string>> {
		const jailed = this.jail(input);
		if (!jailed.ok) return Promise.resolve(jailed);
		return this.raw
			.lstat(jailed.path)
			.then((stat) => {
				if (!stat.isDirectory) {
					return fail<string>({
						code: "not_directory",
						message: "ENOTDIR: not a directory",
						path: jailed.path,
					});
				}
				const id = crypto.randomUUID();
				this.readers.set(id, {
					kind: "dir",
					path: jailed.path,
					yielded: new Set(),
					closed: false,
				});
				return ok(id);
			})
			.catch((error: unknown) => fail<string>(mapError(error, jailed.path)));
	}

	async dirNext(
		id: string,
		maxEntries: number,
	): Promise<OpResult<{ entries: FileInfoPlain[]; done: boolean }>> {
		const reader = this.readers.get(id);
		if (reader?.kind !== "dir" || reader.closed) {
			return fail({ code: "invalid", message: "reader is closed" });
		}
		if (!Number.isInteger(maxEntries) || maxEntries < 1) {
			return fail({
				code: "invalid",
				message: "maxEntries must be a positive integer",
			});
		}
		let names: string[] = [];
		try {
			names = await this.raw.readdir(reader.path);
		} catch (error) {
			return fail(mapError(error, reader.path));
		}
		const entries: FileInfoPlain[] = [];
		for (const name of names) {
			if (reader.yielded.has(name)) continue;
			const path = `${reader.path}/${name}`;
			try {
				const info = await this.infoAt(path, false);
				reader.yielded.add(name);
				entries.push(info);
				if (entries.length >= maxEntries) {
					return ok({ entries, done: false });
				}
			} catch {
				// Skip entries removed before their metadata was read.
			}
		}
		return ok({ entries, done: true });
	}

	async exists(input: string): Promise<OpResult<boolean>> {
		const jailed = this.jail(input);
		if (!jailed.ok) return jailed;
		try {
			await this.raw.lstat(jailed.path);
			return ok(true);
		} catch (error) {
			const mapped = mapError(error, jailed.path);
			if (mapped.code === "not_found") return ok(false);
			return fail(mapped);
		}
	}

	async createDir(
		input: string,
		recursive: boolean | undefined,
	): Promise<OpResult<null>> {
		const jailed = this.jail(input);
		if (!jailed.ok) return jailed;
		try {
			if (recursive) this.wrappedMkdirSync(jailed.path);
			else await this.raw.mkdir(jailed.path);
			this.note([jailed.path]);
			this.persistRow({ path: jailed.path, kind: "dir", content: null });
			return ok(null);
		} catch (error) {
			return fail(mapError(error, jailed.path));
		}
	}

	async remove(
		input: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
	): Promise<OpResult<null>> {
		const jailed = this.jail(input);
		if (!jailed.ok) return jailed;
		try {
			await this.wrappedRm(jailed.path, options);
			return ok(null);
		} catch (error) {
			return fail(mapError(error, jailed.path));
		}
	}

	async canonicalPath(input: string): Promise<OpResult<string>> {
		const jailed = this.jail(input);
		if (!jailed.ok) return jailed;
		try {
			const real = await this.raw.realpath(jailed.path);
			if (real !== WORKSPACE_ROOT && !real.startsWith(`${WORKSPACE_ROOT}/`)) {
				return fail({
					code: "permission_denied",
					message: "path escapes /workspace",
					path: input,
				});
			}
			return ok(real);
		} catch (error) {
			return fail(mapError(error, jailed.path));
		}
	}

	async createTempDir(prefix: string | undefined): Promise<OpResult<string>> {
		const dir = `${WORKSPACE_ROOT}/.cadmus-tmp`;
		this.wrappedMkdirSync(dir);
		const path = `${dir}/${prefix ?? "dir"}-${crypto.randomUUID()}`;
		this.wrappedMkdirSync(path);
		return ok(path);
	}

	async createTempFile(
		options:
			| {
					prefix?: string;
					suffix?: string;
			  }
			| undefined,
	): Promise<OpResult<string>> {
		const dir = `${WORKSPACE_ROOT}/.cadmus-tmp`;
		this.wrappedMkdirSync(dir);
		const path = `${dir}/${options?.prefix ?? "file"}-${crypto.randomUUID()}${options?.suffix ?? ""}`;
		this.wrappedWriteSync(path, new Uint8Array());
		return ok(path);
	}

	openWatch(
		targets: readonly {
			path: string;
			recursive?: boolean;
			exclude?: { hidden?: boolean; names?: readonly string[] };
		}[],
	): OpResult<string> {
		const norm: WatchTargetNorm[] = [];
		for (const target of targets) {
			const jailed = this.jail(target.path);
			if (!jailed.ok) return jailed;
			norm.push({
				path: jailed.path,
				recursive: target.recursive === true,
				hidden: target.exclude?.hidden !== false,
				names: [...(target.exclude?.names ?? [])],
			});
		}
		const id = crypto.randomUUID();
		this.watches.set(id, {
			id,
			targets: norm,
			closed: false,
			buffer: [],
			listeners: new Set(),
		});
		this.ensurePoll();
		return ok(id);
	}

	drainWatch(id: string): WatchEvent[] {
		const watch = this.watches.get(id);
		if (!watch || watch.closed) return [];
		return watch.buffer.splice(0, watch.buffer.length);
	}

	private ensurePoll(): void {
		if (this.pollTimer) return;
		this.pollTimer = setInterval(() => {
			void this.pollWatches();
		}, 50);
	}

	async pollNow(): Promise<void> {
		await this.pollWatches();
	}

	private async pollWatches(): Promise<void> {
		if (this.watches.size === 0) {
			if (this.pollTimer) clearInterval(this.pollTimer);
			this.pollTimer = undefined;
			return;
		}
		for (const watch of this.watches.values()) {
			if (watch.closed) continue;
			const sig = await this.watchSignature(watch);
			const prev = this.watchSig.get(watch.id);
			this.watchSig.set(watch.id, sig);
			if (prev !== undefined && prev !== sig) {
				this.pushWatch(watch, {
					paths: watch.targets.map((target) => target.path),
				});
			}
		}
	}

	private async watchSignature(watch: WatchReg): Promise<string> {
		const parts: string[] = [];
		for (const target of watch.targets) {
			parts.push(await this.signatureAt(target, target.path, true));
		}
		return parts.join("\n");
	}

	private async signatureAt(
		target: WatchTargetNorm,
		path: string,
		root: boolean,
	): Promise<string> {
		try {
			const stat = await this.raw.lstat(path);
			const kind = stat.isSymbolicLink ? "l" : stat.isDirectory ? "d" : "f";
			let body = `${path}:${kind}:${stat.size}`;
			if (stat.isSymbolicLink) {
				const link = await this.raw.readlink(path);
				const resolved = this.links.get(path);
				let targetSize = 0;
				if (resolved) {
					try {
						targetSize = (await this.raw.stat(resolved)).size;
					} catch {
						targetSize = 0;
					}
				}
				body += `:${link}:${targetSize}`;
			}
			if (stat.isDirectory && (root || target.recursive)) {
				const names = await this.raw.readdir(path);
				for (const name of names) {
					const child = `${path}/${name}`;
					if (!root && this.watchExcluded(target, child)) continue;
					if (!target.recursive && !root) continue;
					body += `|${await this.signatureAt(target, child, false)}`;
				}
			}
			return body;
		} catch {
			return `${path}:missing`;
		}
	}

	subscribeWatch(
		id: string,
		listener: (event: WatchEvent) => void,
	): WatchEvent[] {
		const watch = this.watches.get(id);
		if (!watch || watch.closed) return [];
		const buffered = watch.buffer.splice(0, watch.buffer.length);
		watch.listeners.add(listener);
		return buffered;
	}

	closeWatch(id: string): void {
		const watch = this.watches.get(id);
		if (!watch) return;
		watch.closed = true;
		watch.listeners.clear();
		watch.buffer = [];
		this.watchSig.delete(id);
		this.watches.delete(id);
		if (this.watches.size === 0 && this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
	}

	activeWatches(): number {
		return this.watches.size;
	}

	/**
	 * Report mutations. A watched symlink reports its own path when the target changes.
	 * Hidden names and exclude.names below the watch root are omitted.
	 */
	emitMutation(paths: string[]): void {
		if (this.watches.size === 0) return;
		for (const watch of this.watches.values()) {
			if (watch.closed) continue;
			const reported = new Set<string>();
			for (const target of watch.targets) {
				for (const changed of paths) {
					const hit = this.watchHit(target, changed);
					if (hit && !this.watchExcluded(target, hit)) reported.add(hit);
				}
			}
			if (reported.size > 0) this.pushWatch(watch, { paths: [...reported] });
		}
	}

	private watchHit(
		target: WatchTargetNorm,
		changed: string,
	): string | undefined {
		if (changed === target.path) return target.path;
		const prefix = `${target.path}/`;
		if (changed.startsWith(prefix)) {
			const rel = changed.slice(prefix.length);
			if (!target.recursive && rel.includes("/")) return undefined;
			return changed;
		}
		if (target.path.startsWith(`${changed}/`)) return target.path;
		const link = this.links.get(target.path);
		if (link && (changed === link || changed.startsWith(`${link}/`))) {
			return target.path;
		}
		return undefined;
	}

	private watchExcluded(target: WatchTargetNorm, reported: string): boolean {
		if (reported === target.path) return false;
		const prefix = `${target.path}/`;
		if (!reported.startsWith(prefix)) return false;
		const parts = reported.slice(prefix.length).split("/");
		for (const part of parts) {
			if (target.hidden && part.startsWith(".")) return true;
			if (target.names.includes(part)) return true;
		}
		return false;
	}

	private pushWatch(watch: WatchReg, event: WatchEvent): void {
		if (watch.closed) return;
		if (watch.listeners.size === 0) {
			watch.buffer.push(event);
			return;
		}
		for (const listener of watch.listeners) listener(event);
	}

	async exec(input: {
		callId: string;
		command: string | readonly string[];
		cwd?: string;
		timeoutSeconds?: number;
		env?: Record<string, string>;
	}): Promise<
		OpResult<{
			exitCode: number;
			stdout: string;
			stderr: string;
			runtimeMs: number;
		}>
	> {
		const script = commandToScript(input.command);
		if (!script.ok) return script;
		const cwd = input.cwd === undefined ? this.cwd : this.jail(input.cwd);
		if (typeof cwd !== "string" && !cwd.ok) return cwd;
		const cwdPath = typeof cwd === "string" ? cwd : cwd.path;
		const controller = new AbortController();
		this.aborts.set(input.callId, controller);
		let timedOut = false;
		const timeoutMs = (input.timeoutSeconds ?? 5) * 1000;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutMs);
		const started = Date.now();
		try {
			const result: BashExecResult = await this.bash.exec(script.value, {
				cwd: cwdPath,
				signal: controller.signal,
				env: input.env,
			});
			if (controller.signal.aborted && !timedOut) {
				return fail({ code: "aborted", message: "command aborted" });
			}
			if (timedOut || controller.signal.aborted) {
				return fail({ code: "timeout", message: "command timed out" });
			}
			return ok({
				exitCode: result.exitCode,
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? "",
				runtimeMs: Date.now() - started,
			});
		} catch (error) {
			if (timedOut)
				return fail({ code: "timeout", message: "command timed out" });
			if (controller.signal.aborted) {
				return fail({ code: "aborted", message: "command aborted" });
			}
			return fail({
				code: "unknown",
				message: error instanceof Error ? error.message : String(error),
			});
		} finally {
			clearTimeout(timer);
			this.aborts.delete(input.callId);
		}
	}

	cancelExec(callId: string): void {
		this.aborts.get(callId)?.abort();
	}

	abortAll(): void {
		for (const controller of this.aborts.values()) controller.abort();
	}
}

function commandToScript(
	command: string | readonly string[],
): OpResult<string> {
	if (typeof command === "string") return ok(command);
	if (command.length === 0) {
		return fail({ code: "spawn_error", message: "empty argv" });
	}
	const [program, flag, body, ...rest] = command;
	if (
		(program === "bash" || program === "sh") &&
		flag === "-c" &&
		body !== undefined
	) {
		if (rest.length === 0) return ok(body);
		const argv0 = rest[0] ?? "bash";
		const args = rest.slice(1);
		return ok(
			`bash -c ${shellQuote(body)} ${shellQuote(argv0)}${args.map((arg) => ` ${shellQuote(arg)}`).join("")}`,
		);
	}
	return fail({
		code: "spawn_error",
		message: `cannot spawn ${program ?? ""}`,
	});
}

export function isCapMessage(message: string): boolean {
	return message.includes("namespace byte limit");
}
