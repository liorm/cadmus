/**
 * Host-side bridge for e2e. Vitest's workerd has no listen socket and no
 * child_process, so the real `cadmus-daemon` process runs here and its
 * HTTP and WebSocket bytes are handed to the worker test, which calls the
 * Worker's own `/tools-env/pair` and `/tools-env/ws` handlers.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { DAEMON_BRIDGE_HOST } from "./daemon-bridge-port.js";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export { DAEMON_BRIDGE_HOST };

export interface DaemonBridge {
	port: number;
	eventPort: number;
	close: () => Promise<void>;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Control {
	testId: string;
	queue: unknown[];
	waiters: Array<(value: unknown) => void>;
	send: (value: unknown) => void;
	children: ChildProcess[];
	dirs: string[];
	dedicated?: Server;
}

interface PendingHttp {
	resolve: (value: {
		status: number;
		body: string;
		headers?: Record<string, string>;
	}) => void;
}

export async function startDaemonBridge(): Promise<DaemonBridge> {
	const controls = new Map<string, Control>();
	const disposing = new Set<string>();
	const httpWaiters = new Map<string, PendingHttp>();
	const daemonSockets = new Map<string, Socket>();
	const pendingDaemonFrames = new Map<string, string[]>();
	let seq = 0;

	const sendControl = (testId: string, value: unknown): boolean => {
		const control = controls.get(testId);
		if (!control) return false;
		control.send(value);
		return true;
	};

	const bindHttp = (testId: string): Server => {
		const dedicated = createServer((req, res) => {
			void readBody(req).then((body) => {
				void proxyHttp(testId, req, body)
					.then((result) => {
						const headers = result.headers ?? {
							"content-type": "application/json; charset=utf-8",
						};
						res.writeHead(result.status, headers);
						res.end(result.body);
					})
					.catch((error: unknown) => {
						const message =
							error instanceof Error ? error.message : String(error);
						res.writeHead(502, { "content-type": "text/plain" });
						res.end(message);
					});
			});
		});
		dedicated.on("upgrade", (req, socket) => {
			void proxyUpgrade(testId, req, socket as Socket).catch(
				(error: unknown) => {
					const message =
						error instanceof Error ? error.message : String(error);
					try {
						socket.write(
							`HTTP/1.1 502 Bad Gateway\r\nContent-Length: ${Buffer.byteLength(message)}\r\nConnection: close\r\n\r\n${message}`,
						);
					} catch {
						// The daemon already went away.
					}
					socket.destroy();
				},
			);
		});
		return dedicated;
	};

	const serve = (
		req: IncomingMessage,
		res: import("node:http").ServerResponse,
	) => {
		void readBody(req).then((body) => {
			void handleControl(req, res, body).catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				if (!res.headersSent)
					res.writeHead(500, { "content-type": "text/plain" });
				res.end(message);
			});
		});
	};
	const server: Server = createServer(serve);
	const eventServer: Server = createServer(serve);

	async function handleControl(
		req: IncomingMessage,
		res: import("node:http").ServerResponse,
		body: string,
	): Promise<void> {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (req.method === "POST" && url.pathname === "/session") {
			const parsed = JSON.parse(body) as { testId?: string };
			const testId = parsed.testId ?? "";
			const dedicatedPort = await openSession(testId);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ port: dedicatedPort, eventPort }));
			return;
		}
		if (req.method === "GET" && url.pathname === "/event") {
			const testId = url.searchParams.get("testId") ?? "";
			const control = controls.get(testId);
			if (!control) {
				res.writeHead(404);
				res.end();
				return;
			}
			const event = await takeEvent(control, req);
			if (!res.destroyed) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify(event));
			}
			return;
		}
		if (req.method === "POST" && url.pathname === "/event") {
			const message = JSON.parse(body) as Record<string, unknown>;
			await onControlMessage(message);
			res.writeHead(204);
			res.end();
			return;
		}
		res.writeHead(404);
		res.end();
	}

	async function openSession(testId: string): Promise<number> {
		const control: Control = {
			testId,
			queue: [],
			waiters: [],
			children: [],
			dirs: [],
			send: (value) => {
				const waiter = control.waiters.shift();
				if (waiter) waiter(value);
				else control.queue.push(value);
			},
		};
		controls.set(testId, control);
		const dedicated = bindHttp(testId);
		control.dedicated = dedicated;
		return await new Promise<number>((resolve, reject) => {
			dedicated.once("error", reject);
			dedicated.listen(0, DAEMON_BRIDGE_HOST, () => {
				dedicated.unref();
				const addr = dedicated.address();
				if (addr && typeof addr === "object") resolve(addr.port);
				else reject(new Error("dedicated bridge has no port"));
			});
		});
	}

	function takeEvent(control: Control, req: IncomingMessage): Promise<unknown> {
		const queued = control.queue.shift();
		if (queued !== undefined) return Promise.resolve(queued);
		return new Promise((resolve) => {
			const finish = (value: unknown) => resolve(value);
			control.waiters.push(finish);
			req.on("close", () => {
				const index = control.waiters.indexOf(finish);
				if (index >= 0) {
					control.waiters.splice(index, 1);
					resolve({ type: "stopped" });
				}
			});
		});
	}

	async function proxyHttp(
		testId: string,
		req: IncomingMessage,
		body: string,
	): Promise<{
		status: number;
		body: string;
		headers?: Record<string, string>;
	}> {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (!controls.has(testId)) {
			return { status: 404, body: "no worker attached for this flow" };
		}
		const id = `${testId}:${++seq}`;
		const headers = pickHeaders(req.headers);
		const answered = new Promise<{
			status: number;
			body: string;
			headers?: Record<string, string>;
		}>((resolve, reject) => {
			const timer = setTimeout(() => {
				httpWaiters.delete(id);
				reject(new Error("worker did not answer the daemon HTTP call"));
			}, 10_000);
			httpWaiters.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
			});
		});
		sendControl(testId, {
			type: "http",
			id,
			method: req.method ?? "GET",
			path: `${url.pathname}${url.search}`,
			headers,
			body,
		});
		return answered;
	}

	async function proxyUpgrade(
		testId: string,
		req: IncomingMessage,
		socket: Socket,
	): Promise<void> {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (!controls.has(testId)) {
			socket.write(
				"HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
			);
			socket.destroy();
			return;
		}
		const id = `${testId}:${++seq}`;
		pendingDaemonFrames.set(id, []);
		const decisionPromise = waitForControl(id);
		sendControl(testId, {
			type: "ws-offer",
			id,
			path: `${url.pathname}${url.search}`,
			headers: pickHeaders(req.headers),
		});
		const decision = await decisionPromise;
		if (decision.type === "ws-deny") {
			pendingDaemonFrames.delete(id);
			const body = decision.body ?? "";
			socket.write(
				`HTTP/1.1 ${decision.status ?? 401} Denied\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
			);
			socket.destroy();
			return;
		}
		acceptWebSocket(req, socket, (text) => {
			sendControl(testId, { type: "ws-frame", id, text });
		});
		daemonSockets.set(id, socket);
		for (const text of pendingDaemonFrames.get(id) ?? [])
			writeText(socket, text);
		pendingDaemonFrames.delete(id);
		socket.on("close", () => {
			daemonSockets.delete(id);
			sendControl(testId, { type: "ws-close", id });
		});
	}

	const decisions = new Map<
		string,
		(value: {
			type: string;
			status?: number;
			body?: string;
			text?: string;
		}) => void
	>();

	function waitForControl(
		id: string,
	): Promise<{ type: string; status?: number; body?: string }> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				decisions.delete(id);
				reject(new Error("worker did not accept the daemon websocket"));
			}, 10_000);
			decisions.set(id, (value) => {
				clearTimeout(timer);
				resolve(value);
			});
		});
	}

	async function onControlMessage(
		message: Record<string, unknown>,
	): Promise<void> {
		const testId = typeof message.testId === "string" ? message.testId : "";
		const control = controls.get(testId);
		if (!control) return;
		if (message.type === "http-result" && typeof message.id === "string") {
			const waiter = httpWaiters.get(message.id);
			httpWaiters.delete(message.id);
			waiter?.resolve({
				status: typeof message.status === "number" ? message.status : 500,
				body: typeof message.body === "string" ? message.body : "",
				headers:
					message.headers && typeof message.headers === "object"
						? (message.headers as Record<string, string>)
						: undefined,
			});
			return;
		}
		if (
			(message.type === "ws-ready" || message.type === "ws-deny") &&
			typeof message.id === "string"
		) {
			decisions.get(message.id)?.({
				type: message.type,
				status: typeof message.status === "number" ? message.status : undefined,
				body: typeof message.body === "string" ? message.body : undefined,
			});
			decisions.delete(message.id);
			return;
		}
		if (message.type === "ws-send" && typeof message.id === "string") {
			const text = typeof message.text === "string" ? message.text : "";
			const daemon = daemonSockets.get(message.id);
			if (daemon) writeText(daemon, text);
			else pendingDaemonFrames.get(message.id)?.push(text);
			return;
		}
		if (message.type === "ws-close" && typeof message.id === "string") {
			const daemon = daemonSockets.get(message.id);
			if (daemon) closeWebSocket(daemon);
			return;
		}
		if (message.type === "spawn") {
			const token = typeof message.token === "string" ? message.token : "";
			const workspace = await mkdtemp(join(tmpdir(), "cadmus-daemon-"));
			const configDir = await mkdtemp(join(tmpdir(), "cadmus-daemon-cfg-"));
			control.dirs.push(workspace, configDir);
			const child = spawn(
				"bun",
				[
					"packages/daemon/src/cli.ts",
					"pair",
					token,
					"--name",
					"user-flow",
					"--workspace",
					workspace,
					"--config",
					join(configDir, "daemon.json"),
				],
				{
					cwd: repoRoot,
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			unrefReadable(child.stdout);
			unrefReadable(child.stderr);
			child.unref();
			control.children.push(child);
			liveDaemons.push(child);
			const log = (stream: string, chunk: Buffer) => {
				control.send({
					type: "log",
					stream,
					text: chunk.toString("utf8"),
				});
			};
			child.stdout?.on("data", (chunk: Buffer) => log("stdout", chunk));
			child.stderr?.on("data", (chunk: Buffer) => log("stderr", chunk));
			child.on("exit", (code) => {
				control.send({ type: "exit", code });
			});
			return;
		}
		if (message.type === "stop") {
			await disposeControl(testId);
		}
	}

	async function disposeControl(testId: string): Promise<void> {
		if (disposing.has(testId)) return;
		disposing.add(testId);
		const control = controls.get(testId);
		if (!control) return;
		controls.delete(testId);
		for (const waiter of control.waiters) waiter({ type: "stopped" });
		control.waiters.length = 0;
		for (const [id, daemon] of daemonSockets) {
			if (!id.startsWith(`${testId}:`)) continue;
			closeWebSocket(daemon);
			daemon.destroy();
			daemonSockets.delete(id);
		}
		for (const child of control.children) {
			killProcessGroup(child, "SIGKILL");
		}
		if (control.dedicated) {
			const dedicated = control.dedicated;
			dedicated.closeAllConnections?.();
			await new Promise<void>((resolve) => dedicated.close(() => resolve()));
		}
		await Promise.all(
			control.dirs.map((dir) => rm(dir, { recursive: true, force: true })),
		);
	}

	const port = await listenEphemeral(server);
	const eventPort = await listenEphemeral(eventServer);

	return {
		port,
		eventPort,
		close: async () => {
			for (const testId of [...controls.keys()]) await disposeControl(testId);
			server.closeAllConnections?.();
			eventServer.closeAllConnections?.();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await new Promise<void>((resolve) => eventServer.close(() => resolve()));
		},
	};
}

function listenEphemeral(server: Server): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, DAEMON_BRIDGE_HOST, () => {
			server.unref();
			const addr = server.address();
			if (addr && typeof addr === "object") resolve(addr.port);
			else reject(new Error("daemon bridge has no port"));
		});
	});
}

/** Child stdio pipes are sockets. Readable's type omits `unref`. */
function unrefReadable(stream: NodeJS.ReadableStream | null): void {
	(stream as (Duplex & { unref?: () => void }) | null)?.unref?.();
}

function pickHeaders(
	headers: IncomingMessage["headers"],
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (value === undefined) continue;
		const joined = Array.isArray(value) ? value.join(", ") : value;
		const lower = key.toLowerCase();
		if (
			lower === "authorization" ||
			lower === "content-type" ||
			lower.startsWith("x-cadmus-") ||
			lower === "upgrade"
		) {
			out[key] = joined;
		}
	}
	return out;
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function acceptWebSocket(
	req: IncomingMessage,
	socket: Socket,
	onText: (text: string) => void,
): void {
	const key = req.headers["sec-websocket-key"];
	const accept = createHash("sha1")
		.update(String(key) + WS_GUID)
		.digest("base64");
	socket.write(
		`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
	);
	let buf = Buffer.alloc(0);
	socket.on("data", (chunk: Buffer) => {
		buf = Buffer.concat([buf, chunk]);
		while (true) {
			const frame = decodeFrame(buf);
			if (!frame) return;
			buf = buf.subarray(frame.bytes);
			if (frame.opcode === 0x8) {
				closeWebSocket(socket);
				return;
			}
			if (frame.opcode === 0x9) {
				socket.write(encodeFrame(frame.payload, 0x8a));
				continue;
			}
			if (frame.opcode === 0x1) onText(frame.payload.toString("utf8"));
		}
	});
}

const liveDaemons: ChildProcess[] = [];
process.on("exit", () => {
	for (const child of liveDaemons) {
		if (child.pid === undefined || child.exitCode !== null) continue;
		try {
			process.kill(child.pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
});

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
	if (child.exitCode !== null || child.pid === undefined) return;
	try {
		process.kill(child.pid, signal);
	} catch {
		// Already gone.
	}
}

function closeWebSocket(socket: Socket): void {
	const marked = socket as Socket & { cadmusClosed?: boolean };
	if (marked.cadmusClosed || socket.destroyed) return;
	marked.cadmusClosed = true;
	try {
		socket.write(Buffer.from([0x88, 0x00]));
	} catch {
		// Already closing.
	}
	socket.end();
}

function writeText(socket: Socket, text: string): void {
	if (socket.destroyed) return;
	socket.write(encodeFrame(Buffer.from(text), 0x81));
}

function encodeFrame(payload: Buffer, firstByte: number): Buffer {
	const len = payload.length;
	let header: Buffer;
	if (len < 126) {
		header = Buffer.from([firstByte, len]);
	} else if (len < 65536) {
		header = Buffer.alloc(4);
		header[0] = firstByte;
		header[1] = 126;
		header.writeUInt16BE(len, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = firstByte;
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(len), 2);
	}
	return Buffer.concat([header, payload]);
}

function decodeFrame(
	buf: Buffer,
): { opcode: number; payload: Buffer; bytes: number } | undefined {
	if (buf.length < 2) return undefined;
	const opcode = buf[0] & 0x0f;
	const masked = (buf[1] & 0x80) !== 0;
	let len = buf[1] & 0x7f;
	let offset = 2;
	if (len === 126) {
		if (buf.length < 4) return undefined;
		len = buf.readUInt16BE(2);
		offset = 4;
	} else if (len === 127) {
		if (buf.length < 10) return undefined;
		len = Number(buf.readBigUInt64BE(2));
		offset = 10;
	}
	const maskLen = masked ? 4 : 0;
	if (buf.length < offset + maskLen + len) return undefined;
	const mask = masked ? buf.subarray(offset, offset + 4) : undefined;
	offset += maskLen;
	const payload = Buffer.from(buf.subarray(offset, offset + len));
	if (mask) {
		for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
	}
	return { opcode, payload, bytes: offset + len };
}
