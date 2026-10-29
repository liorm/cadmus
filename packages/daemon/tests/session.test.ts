import { describe, expect, it } from "bun:test";
import { symlinkSync } from "node:fs";
import { lstat, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { runDaemon } from "../src/cli.js";
import { TRUST_WARNING } from "../src/confine.js";
import type { DaemonLogger } from "../src/log.js";
import { DaemonSession } from "../src/session.js";
import { openDaemonSocket } from "../src/socket.js";
import { prepareWorkspace } from "../src/workspace.js";

async function waitFor(
	check: () => Promise<boolean>,
	timeoutMs = 5_000,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("timed out");
}

describe("daemon session", () => {
	it("kills a sleeping child when the socket closes and keeps the ephemeral dir", async () => {
		const root = await mkdtemp(join(tmpdir(), "cadmus-sleep-"));
		const cwd = prepareWorkspace(root, false);
		const env = new NodeExecutionEnv({ cwd });
		const session = new DaemonSession(env, { cwd, ephemeralDir: cwd });
		session.attach({
			send() {},
			close() {},
		});
		const pidfile = join(cwd, "pid");
		session.handleText(
			JSON.stringify({
				id: "exec-1",
				method: "exec",
				args: { command: `echo $$ > '${pidfile}'; sleep 30` },
			}),
		);
		let pid = 0;
		await waitFor(async () => {
			try {
				pid = Number((await Bun.file(pidfile).text()).trim());
				return pid > 0;
			} catch {
				return false;
			}
		});
		session.dispose();
		await waitFor(async () => {
			try {
				process.kill(pid, 0);
				return false;
			} catch {
				return true;
			}
		});
		expect((await stat(cwd)).isDirectory()).toBe(true);

		const again = new DaemonSession(env, { cwd, ephemeralDir: cwd });
		let cleaned = false;
		again.attach({
			send(text) {
				const frame = JSON.parse(text) as { ok?: boolean };
				if (frame.ok) cleaned = true;
			},
			close() {},
		});
		again.handleText(
			JSON.stringify({
				id: "cleanup-1",
				method: "cleanup",
				args: { deleteEphemeral: true },
			}),
		);
		await waitFor(async () => cleaned);
		await waitFor(async () => {
			try {
				await stat(cwd);
				return false;
			} catch {
				return true;
			}
		});
		again.dispose();
		await rm(root, { recursive: true, force: true });
	});

	it("denies write, append, and read through a dangling symlink to an outside path", async () => {
		const root = await mkdtemp(join(tmpdir(), "cadmus-dangle-"));
		const outside = await mkdtemp(join(tmpdir(), "cadmus-dangle-out-"));
		const target = join(outside, "malicious");
		symlinkSync(target, join(root, "leak"));
		const env = new NodeExecutionEnv({ cwd: root });
		const session = new DaemonSession(env, {
			cwd: root,
			confineToWorkspace: true,
			mechanism: { bwrap: false, sandboxExec: false },
		});
		const frames: Array<Record<string, unknown>> = [];
		session.attach({
			send(text) {
				frames.push(JSON.parse(text) as Record<string, unknown>);
			},
			close() {},
		});
		const call = async (
			id: string,
			method: string,
			args: Record<string, unknown>,
		) => {
			const start = frames.length;
			session.handleText(JSON.stringify({ id, method, args }));
			await waitFor(async () => frames.length > start);
			const frame = frames.find((item) => item.id === id && "ok" in item);
			if (!frame) throw new Error(`no result for ${id}`);
			return frame;
		};
		try {
			for (const [id, method] of [
				["write-1", "writeFile"],
				["append-1", "appendFile"],
				["read-1", "readTextFile"],
			] as const) {
				const frame = await call(id, method, {
					path: "leak",
					content: "pwned",
				});
				expect(frame.ok).toBe(false);
				const error = frame.error as { kind?: string; code?: string };
				expect(error.kind).toBe("file");
				expect(error.code).toBe("permission_denied");
			}
			await expect(stat(target)).rejects.toThrow();
			expect((await lstat(join(root, "leak"))).isSymbolicLink()).toBe(true);
		} finally {
			session.dispose();
			await rm(root, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		}
	});

	it("falls back to the workspace when exec cwd is outside and confinement is on", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "cadmus-cwd-")));
		const outside = await realpath(
			await mkdtemp(join(tmpdir(), "cadmus-cwd-out-")),
		);
		const env = new NodeExecutionEnv({ cwd: root });
		const session = new DaemonSession(env, {
			cwd: root,
			confineToWorkspace: true,
			// No bwrap wrapper: sandbox-exec uses this same options.cwd, and the
			// shell has to run so the assertion can see where it started.
			mechanism: { bwrap: false, sandboxExec: false },
		});
		const frames: Array<Record<string, unknown>> = [];
		session.attach({
			send(text) {
				frames.push(JSON.parse(text) as Record<string, unknown>);
			},
			close() {},
		});
		try {
			session.handleText(
				JSON.stringify({
					id: "cwd-1",
					method: "exec",
					args: {
						command: "pwd > marker-from-cwd",
						cwd: outside,
					},
				}),
			);
			await waitFor(async () =>
				frames.some((frame) => frame.id === "cwd-1" && frame.ok === true),
			);
			const printed = (
				await readFile(join(root, "marker-from-cwd"), "utf8")
			).trim();
			expect(printed).toBe(root);
			await expect(stat(join(outside, "marker-from-cwd"))).rejects.toThrow();
		} finally {
			session.dispose();
			await rm(root, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		}
	});
});

describe("daemon dial", () => {
	it("reads 401 and 409 without retrying, and upgrades a local socket", async () => {
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch(req, server) {
				const url = new URL(req.url);
				if (url.pathname === "/deny")
					return new Response("no", { status: 401 });
				if (url.pathname === "/conflict") {
					return new Response("no", { status: 409 });
				}
				if (server.upgrade(req)) return undefined;
				return new Response("upgrade required", { status: 426 });
			},
			websocket: {
				message(ws, message) {
					const frame = JSON.parse(String(message)) as {
						id?: string;
						method?: string;
					};
					if (frame.method === "heartbeat" && frame.id) {
						ws.send(JSON.stringify({ id: frame.id, ok: true }));
					}
				},
			},
		});
		try {
			const deny = await openDaemonSocket({
				url: `ws://127.0.0.1:${server.port}/deny`,
				headers: {},
			});
			expect(deny.status).toBe(401);
			const conflict = await openDaemonSocket({
				url: `ws://127.0.0.1:${server.port}/conflict`,
				headers: {},
			});
			expect(conflict.status).toBe(409);
			const opened = await openDaemonSocket({
				url: `ws://127.0.0.1:${server.port}/tools-env/ws?envId=ld_test`,
				headers: { Authorization: "Bearer test" },
			});
			expect(opened.status).toBe(101);
			const reply = new Promise<string>((resolve) => {
				opened.socket?.onMessage(resolve);
			});
			opened.socket?.send(JSON.stringify({ id: "hb", method: "heartbeat" }));
			expect(JSON.parse(await reply)).toEqual({ id: "hb", ok: true });
			opened.socket?.close();
		} finally {
			server.stop(true);
		}
	});

	it("stops the reconnect loop on 401 and 409 and does not dial when confinement is missing", async () => {
		const warnings: string[] = [];
		let dials = 0;
		await runDaemon({
			url: "ws://127.0.0.1/tools-env/ws",
			token: `cadmus_dk_${"ab".repeat(32)}`,
			envId: "ld_test",
			workspacePath: "/tmp/cadmus-not-used",
			persist: true,
			confineToWorkspace: false,
			detector: { bwrap: false, sandboxExec: false },
			onWarning: (line) => warnings.push(line),
			sleep: async () => {
				throw new Error("slept");
			},
			dial: async () => {
				dials += 1;
				return { status: 401 };
			},
		});
		expect(dials).toBe(1);
		expect(warnings).toEqual([TRUST_WARNING]);

		dials = 0;
		await runDaemon({
			url: "ws://127.0.0.1/tools-env/ws",
			token: `cadmus_dk_${"ab".repeat(32)}`,
			envId: "ld_test",
			workspacePath: "/tmp/cadmus-not-used",
			persist: true,
			confineToWorkspace: true,
			detector: { bwrap: true, sandboxExec: false },
			onWarning: () => {
				throw new Error("warned");
			},
			sleep: async () => {
				throw new Error("slept");
			},
			dial: async () => {
				dials += 1;
				return { status: 409 };
			},
		});
		expect(dials).toBe(1);

		let refused = false;
		try {
			await runDaemon({
				url: "ws://127.0.0.1/tools-env/ws",
				token: `cadmus_dk_${"ab".repeat(32)}`,
				envId: "ld_test",
				workspacePath: "/tmp/cadmus-not-used",
				persist: true,
				confineToWorkspace: true,
				detector: { bwrap: false, sandboxExec: false },
				dial: async () => {
					throw new Error("dialed");
				},
			});
		} catch (error) {
			refused =
				error instanceof Error && error.message.includes("Refusing to start");
		}
		expect(refused).toBe(true);
	});

	it("doubles the wait between failed dials and resets the sequence after accept", async () => {
		const delays: number[] = [];
		const signal = new AbortController();
		let dials = 0;
		await runDaemon({
			url: "ws://127.0.0.1/tools-env/ws",
			token: `cadmus_dk_${"cd".repeat(32)}`,
			envId: "ld_test",
			workspacePath: "/tmp/cadmus-not-used",
			persist: true,
			confineToWorkspace: false,
			detector: { bwrap: false, sandboxExec: false },
			onWarning() {},
			signal: signal.signal,
			random: () => 0.5,
			sleep: async (ms) => {
				delays.push(ms);
			},
			dial: async () => {
				dials += 1;
				if (dials === 3) signal.abort();
				return { status: 500 };
			},
		});
		expect(delays).toEqual([1_000, 2_000]);
	});

	it("backs off when the dial rejects instead of exiting", async () => {
		const delays: number[] = [];
		const signal = new AbortController();
		let dials = 0;
		await runDaemon({
			url: "ws://127.0.0.1/tools-env/ws",
			token: `cadmus_dk_${"ef".repeat(32)}`,
			envId: "ld_test",
			workspacePath: "/tmp/cadmus-not-used",
			persist: true,
			confineToWorkspace: false,
			detector: { bwrap: false, sandboxExec: false },
			onWarning() {},
			signal: signal.signal,
			random: () => 0.5,
			sleep: async (ms) => {
				delays.push(ms);
			},
			dial: async () => {
				dials += 1;
				if (dials === 3) signal.abort();
				throw Object.assign(new Error("connect ECONNREFUSED"), {
					code: "ECONNREFUSED",
				});
			},
		});
		expect(dials).toBe(3);
		expect(delays).toEqual([1_000, 2_000]);
	});

	it("backs off when a local dial hits the connect timeout", async () => {
		const server = createServer();
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", () => resolve());
		});
		const address = server.address();
		if (!address || typeof address === "string") {
			server.close();
			throw new Error("no port");
		}
		const delays: number[] = [];
		const signal = new AbortController();
		let dials = 0;
		try {
			await runDaemon({
				url: `ws://127.0.0.1:${address.port}/tools-env/ws`,
				token: `cadmus_dk_${"12".repeat(32)}`,
				envId: "ld_test",
				workspacePath: "/tmp/cadmus-not-used",
				persist: true,
				confineToWorkspace: false,
				detector: { bwrap: false, sandboxExec: false },
				onWarning() {},
				signal: signal.signal,
				random: () => 0.5,
				sleep: async (ms) => {
					delays.push(ms);
				},
				dial: (input) => {
					dials += 1;
					if (dials === 2) {
						signal.abort();
						throw new Error("stop");
					}
					return openDaemonSocket({ ...input, timeoutMs: 40 });
				},
			});
		} finally {
			server.close();
		}
		expect(dials).toBe(2);
		expect(delays).toEqual([1_000]);
	});

	it("logs daemon operations with operational details", async () => {
		const root = await mkdtemp(join(tmpdir(), "cadmus-log-test-"));
		const cwd = prepareWorkspace(root, false);
		const env = new NodeExecutionEnv({ cwd });
		const logs: Array<{
			level: string;
			message: string;
			meta?: Record<string, unknown>;
		}> = [];
		const testLogger: DaemonLogger = {
			debug(message, meta) {
				logs.push({ level: "debug", message, meta });
			},
			info(message, meta) {
				logs.push({ level: "info", message, meta });
			},
			warn(message, meta) {
				logs.push({ level: "warn", message, meta });
			},
			error(message, meta) {
				logs.push({ level: "error", message, meta });
			},
			child() {
				return testLogger;
			},
		};
		const session = new DaemonSession(env, {
			cwd,
			ephemeralDir: cwd,
			logger: testLogger,
		});
		session.attach({
			send() {},
			close() {},
		});

		session.handleText(
			JSON.stringify({
				id: "w-1",
				method: "writeFile",
				args: { path: "hello.txt", content: "hello world" },
			}),
		);
		await waitFor(async () => logs.some((l) => l.message === "file.write"));
		const writeLog = logs.find((l) => l.message === "file.write");
		expect(writeLog?.meta?.path).toBe("hello.txt");
		expect(writeLog?.meta?.bytes).toBe(11);

		session.handleText(
			JSON.stringify({
				id: "r-1",
				method: "readTextFile",
				args: { path: "hello.txt" },
			}),
		);
		await waitFor(async () => logs.some((l) => l.message === "file.readText"));
		const readLog = logs.find((l) => l.message === "file.readText");
		expect(readLog?.meta?.path).toBe("hello.txt");

		session.handleText(
			JSON.stringify({
				id: "e-1",
				method: "exec",
				args: { command: "echo test" },
			}),
		);
		await waitFor(async () => logs.some((l) => l.message === "exec.finish"));
		const execStart = logs.find((l) => l.message === "exec.start");
		expect(execStart?.meta?.command).toBe("echo test");
		const execFinish = logs.find((l) => l.message === "exec.finish");
		expect(execFinish?.meta?.exitCode).toBe(0);

		session.dispose();
	});
});
