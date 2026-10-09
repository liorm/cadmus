import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { EnvTarget } from "@earendil-works/pi-durable";
import { err, ExecutionError, type ExecutionEnv, FileError, type Result } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { ChatsDoc } from "../channels/telegram/chats.ts";

function outside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel.startsWith("..") || isAbsolute(rel);
}

/** The path stays inside `root` after resolving existing symlinks. Missing leaves are checked lexically. */
async function staysInside(root: string, candidate: string): Promise<boolean> {
	let rootReal: string;
	try {
		rootReal = await realpath(root);
	} catch {
		return false;
	}
	const lexical = resolve(candidate);
	if (outside(rootReal, lexical)) return false;
	let current = lexical;
	const missing: string[] = [];
	for (;;) {
		try {
			const real = await realpath(current);
			if (outside(rootReal, real)) return false;
			return !outside(rootReal, resolve(real, ...missing));
		} catch {
			const parent = dirname(current);
			if (parent === current) return false;
			missing.unshift(basename(current));
			current = parent;
		}
	}
}

function refused(path: string): Result<string, FileError> {
	return err(new FileError("permission_denied", `Path is outside the bot folder: ${path}`, path));
}

/**
 * Map a path the inner env already made absolute from the bot root.
 * `disk/…` becomes `users/<userId>/disk/…`. Another user's `users/` tree is refused, and so is anything outside the folder.
 */
async function resolveInside(
	inner: NodeExecutionEnv,
	root: string,
	userId: number | undefined,
	path: string,
	context: Context,
): Promise<Result<string, FileError>> {
	const lexical = await inner.absolutePath(path, context);
	if (!lexical.ok) return lexical;
	let rel = relative(root, lexical.value);
	if (outside(root, lexical.value)) return refused(path);
	const diskPrefix = `disk${sep}`;
	if (rel === "disk" || rel.startsWith(diskPrefix)) {
		if (userId === undefined) return refused(path);
		const rest = rel === "disk" ? "" : rel.slice(diskPrefix.length);
		rel = rest ? join("users", String(userId), "disk", rest) : join("users", String(userId), "disk");
	}
	const usersPrefix = `users${sep}`;
	if (rel === "users" || rel.startsWith(usersPrefix)) {
		const own = userId === undefined ? undefined : join("users", String(userId));
		const self = own !== undefined && (rel === own || rel.startsWith(own + sep));
		if (!self) return refused(path);
	}
	const full = join(root, rel);
	if (!(await staysInside(root, full))) return refused(path);
	return { ok: true, value: full };
}

function botExecutionEnv(root: string, userId: number | undefined): ExecutionEnv {
	const inner = new NodeExecutionEnv({ cwd: root });
	const resolvePath = (path: string, context: Context) => resolveInside(inner, root, userId, path, context);
	return new Proxy(inner, {
		get(target, prop, receiver) {
			if (prop === "absolutePath") return (path: string, context: Context) => resolvePath(path, context);
			if (prop === "writeFile") {
				return async (path: string, content: string | Uint8Array, context: Context) => {
					const resolved = await resolvePath(path, context);
					if (!resolved.ok) return resolved;
					return target.writeFile(resolved.value, content, context);
				};
			}
			if (prop === "renameFile") {
				return async (source: string, destination: string, context: Context) => {
					const from = await resolvePath(source, context);
					if (!from.ok) return from;
					const to = await resolvePath(destination, context);
					if (!to.ok) return to;
					return target.renameFile(from.value, to.value, context);
				};
			}
			if (prop === "remove") {
				return async (path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context) => {
					const resolved = await resolvePath(path, context);
					if (!resolved.ok) return resolved;
					return target.remove(resolved.value, options, context);
				};
			}
			if (prop === "exec") {
				return async () => err(new ExecutionError("shell_unavailable", "shell is unavailable"));
			}
			const value = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as ExecutionEnv;
}

/** `HarnessOptions.env`: no agent cwd means no env. `userId` comes from the chat of this conversation. */
export function botEnv(): (target: EnvTarget, context: Context) => Promise<ExecutionEnv | undefined> {
	return async (target, context) => {
		if (!target.cwd) return undefined;
		const chats = await target.read.snapshot(ChatsDoc, context);
		const userId = chats?.items.find((chat) => chat.conversationId === target.conversationId)?.userId;
		return botExecutionEnv(target.cwd, userId);
	};
}
