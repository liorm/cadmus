import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { FileError } from "@earendil-works/pi-durable/env";

export interface ConfineDetector {
	bwrap: boolean;
	sandboxExec: boolean;
}

export const TRUST_WARNING =
	"cadmus-daemon: confinement is off. This process runs as the current OS user and workspacePath is the working directory, not a sandbox.";

export function whichOnPath(
	name: string,
	pathEnv = process.env.PATH ?? "",
): boolean {
	return pathEnv
		.split(":")
		.filter((dir) => dir.length > 0)
		.some((dir) => existsSync(`${dir}/${name}`));
}

export function detectConfineMechanisms(
	which: (name: string) => boolean = whichOnPath,
): ConfineDetector {
	return { bwrap: which("bwrap"), sandboxExec: which("sandbox-exec") };
}

export function hasConfineMechanism(detector: ConfineDetector): boolean {
	return detector.bwrap || detector.sandboxExec;
}

export function startupDecision(input: {
	confineToWorkspace: boolean;
	detector: ConfineDetector;
}):
	| { start: true; capability: boolean; warning?: string }
	| { start: false; reason: string } {
	if (input.confineToWorkspace) {
		if (!hasConfineMechanism(input.detector)) {
			return {
				start: false,
				reason:
					"No confinement mechanism (bwrap or sandbox-exec). Refusing to start.",
			};
		}
		return { start: true, capability: true };
	}
	return { start: true, capability: false, warning: TRUST_WARNING };
}

function insideRoot(root: string, path: string): boolean {
	const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
	return path === root || path.startsWith(prefix);
}

function denied(
	input: string,
	message: string,
): { ok: false; error: FileError } {
	return {
		ok: false,
		error: new FileError("permission_denied", message, input),
	};
}

function errnoOf(error: unknown): string | undefined {
	if (!error || typeof error !== "object" || !("code" in error))
		return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

/** Dangling symlink target, or undefined when the entry is absent or not a link. */
function danglingSymlinkTarget(current: string): string | undefined {
	try {
		if (!lstatSync(current).isSymbolicLink()) return undefined;
		const raw = readlinkSync(current);
		return isAbsolute(raw) ? resolve(raw) : resolve(dirname(current), raw);
	} catch {
		return undefined;
	}
}

/**
 * Realpath jail. A symlink whose target leaves the workspace is permission_denied.
 * A dangling link has no realpath (ENOENT); lstat + readlink still jail its target.
 * Missing files are allowed when every existing ancestor stays inside.
 */
export function confinePath(
	workspace: string,
	input: string,
): { ok: true; path: string } | { ok: false; error: FileError } {
	return confinePathSeen(workspace, input, new Set());
}

function confinePathSeen(
	workspace: string,
	input: string,
	seen: Set<string>,
): { ok: true; path: string } | { ok: false; error: FileError } {
	let root: string;
	try {
		root = realpathSync(workspace);
	} catch {
		return denied(input, "workspace is not available");
	}
	const candidate = isAbsolute(input) ? input : resolve(root, input);
	const missing: string[] = [];
	let current = candidate;
	while (true) {
		try {
			const real = realpathSync(current);
			if (!insideRoot(root, real)) {
				return denied(input, "path escapes the workspace");
			}
			const path =
				missing.length === 0 ? real : resolve(real, ...missing.reverse());
			if (!insideRoot(root, path) && path !== root) {
				return denied(input, "path escapes the workspace");
			}
			return { ok: true, path };
		} catch (error) {
			if (errnoOf(error) === "ENOENT") {
				const target = danglingSymlinkTarget(current);
				if (target) {
					if (seen.has(target)) {
						return denied(input, "path escapes the workspace");
					}
					seen.add(target);
					const confined = confinePathSeen(workspace, target, seen);
					if (!confined.ok) return denied(input, "path escapes the workspace");
				}
			}
			const parent = dirname(current);
			if (parent === current) {
				return denied(input, "path escapes the workspace");
			}
			missing.push(basename(current));
			current = parent;
		}
	}
}

export function confinedExecArgv(input: {
	mechanism: "bwrap" | "sandbox-exec";
	workspace: string;
	command: string | readonly string[];
}): string[] {
	const inner =
		typeof input.command === "string"
			? ["sh", "-c", input.command]
			: [...input.command];
	if (input.mechanism === "bwrap") {
		const libraryBinds = ["/lib", "/lib64", "/etc"]
			.filter((dir) => existsSync(dir))
			.flatMap((dir) => ["--ro-bind", dir, dir]);
		return [
			"bwrap",
			"--die-with-parent",
			"--ro-bind",
			"/usr",
			"/usr",
			"--ro-bind",
			"/bin",
			"/bin",
			...libraryBinds,
			"--proc",
			"/proc",
			"--dev",
			"/dev",
			"--bind",
			input.workspace,
			input.workspace,
			"--chdir",
			input.workspace,
			...inner,
		];
	}
	let realWorkspace = input.workspace;
	try {
		realWorkspace = realpathSync(input.workspace);
	} catch {
		// Keep input.workspace if it does not resolve yet.
	}
	const readPaths = new Set([input.workspace, realWorkspace]);
	const readSubpaths = [...readPaths]
		.map((p) => `(subpath ${sbplString(p)})`)
		.join(" ");
	const writeSubpaths = [...readPaths, "/dev/fd"]
		.map((p) => `(subpath ${sbplString(p)})`)
		.join(" ");
	const profile = [
		"(version 1)",
		"(deny default)",
		"(allow process*)",
		"(allow file-read*)",
		'(deny file-read-data (subpath "/Users") (subpath "/home") (subpath "/Volumes") (subpath "/tmp") (subpath "/private/tmp") (subpath "/var/folders") (subpath "/private/var/folders"))',
		`(allow file-read-data ${readSubpaths})`,
		`(allow file-write* ${writeSubpaths} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty"))`,
		"(allow sysctl-read)",
	].join("");
	return ["sandbox-exec", "-p", profile, ...inner];
}

function sbplString(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
