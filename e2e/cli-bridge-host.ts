/**
 * Host side of the CLI e2e. Vitest's workerd cannot spawn processes, so this
 * process starts `cadmus` and parks its HTTP and WebSocket traffic for the
 * test to forward through `SELF.fetch` (the same worker the test provisions).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { dirname, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { DAEMON_BRIDGE_HOST } from "./daemon-bridge-port.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliEntrypoint = resolve(root, "packages/cli/src/cli.ts");

interface HttpJob {
	kind: "http";
	id: string;
	method: string;
	path: string;
	headers: Record<string, string>;
	bodyB64: string;
}

interface WsJob {
	kind: "ws-open" | "ws-frame" | "ws-close";
	id: string;
	path?: string;
	text?: string;
}

type Job = HttpJob | WsJob;

interface Proc {
	child: ChildProcess;
	stdout: string;
	stderr: string;
	code: number | null;
}

export async function startCliBridge(): Promise<{
	port: number;
	close: () => Promise<void>;
}> {
	const queue: Job[] = [];
	const waiters: ((job: Job | undefined) => void)[] = [];
	const httpPending = new Map<string, ServerResponse>();
	const sockets = new Map<string, Duplex>();
	const procs = new Map<string, Proc>();

	function enqueue(job: Job): void {
		const waiter = waiters.shift();
		if (waiter) waiter(job);
		else queue.push(job);
	}

	async function readBody(req: IncomingMessage): Promise<Buffer> {
		const chunks: Buffer[] = [];
		for await (const chunk of req) {
			chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		}
		return Buffer.concat(chunks);
	}

	const server = createServer((req, res) => {
		void handle(req, res);
	});

	async function handle(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (url.pathname === "/__pull") {
			const job = queue.shift();
			if (job) {
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify(job));
				return;
			}
			const timer = setTimeout(() => {
				const index = waiters.indexOf(deliver);
				if (index >= 0) waiters.splice(index, 1);
				res.statusCode = 204;
				res.end();
			}, 200);
			const deliver = (job: Job | undefined): void => {
				clearTimeout(timer);
				if (!job) {
					res.statusCode = 204;
					res.end();
					return;
				}
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify(job));
			};
			waiters.push(deliver);
			return;
		}
		if (url.pathname === "/__cli/start" && req.method === "POST") {
			const body = JSON.parse((await readBody(req)).toString("utf8")) as {
				args?: string[];
				stdin?: string;
				env?: Record<string, string>;
			};
			const id = crypto.randomUUID();
			const child = spawn("bun", [cliEntrypoint, ...(body.args ?? [])], {
				cwd: root,
				env: { ...process.env, ...body.env },
				stdio: ["pipe", "pipe", "pipe"],
			});
			const proc: Proc = { child, stdout: "", stderr: "", code: null };
			procs.set(id, proc);
			child.stdout?.setEncoding("utf8");
			child.stderr?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => {
				proc.stdout += chunk;
			});
			child.stderr?.on("data", (chunk: string) => {
				proc.stderr += chunk;
			});
			child.on("close", (code) => {
				proc.code = code ?? 1;
			});
			if (body.stdin !== undefined) {
				child.stdin?.end(body.stdin);
			} else {
				child.stdin?.end();
			}
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ id }));
			return;
		}
		const statusMatch = url.pathname.match(/^\/__cli\/([^/]+)$/);
		if (statusMatch && req.method === "GET") {
			const proc = procs.get(statusMatch[1] ?? "");
			if (!proc) {
				res.statusCode = 404;
				res.end();
				return;
			}
			res.setHeader("content-type", "application/json");
			res.end(
				JSON.stringify({
					code: proc.code,
					stdout: proc.stdout,
					stderr: proc.stderr,
				}),
			);
			return;
		}
		const signalMatch = url.pathname.match(/^\/__cli\/([^/]+)\/signal$/);
		if (signalMatch && req.method === "POST") {
			const proc = procs.get(signalMatch[1] ?? "");
			const body = JSON.parse((await readBody(req)).toString("utf8")) as {
				signal?: NodeJS.Signals;
			};
			if (proc && proc.code === null) proc.child.kill(body.signal ?? "SIGINT");
			res.end("{}");
			return;
		}
		const replyMatch = url.pathname.match(/^\/__reply\/([^/]+)$/);
		if (replyMatch && req.method === "POST") {
			const pending = httpPending.get(replyMatch[1] ?? "");
			const body = await readBody(req);
			if (!pending) {
				res.statusCode = 404;
				res.end();
				return;
			}
			httpPending.delete(replyMatch[1] ?? "");
			const status = Number(req.headers["x-status"] ?? 200);
			pending.statusCode = Number.isFinite(status) ? status : 200;
			const type = req.headers["x-content-type"];
			if (typeof type === "string" && type.length > 0) {
				pending.setHeader("content-type", type);
			}
			pending.end(body);
			res.end("ok");
			return;
		}
		const wsFrame = url.pathname.match(/^\/__ws\/([^/]+)\/frame$/);
		if (wsFrame && req.method === "POST") {
			const socket = sockets.get(wsFrame[1] ?? "");
			const body = JSON.parse((await readBody(req)).toString("utf8")) as {
				text?: string;
			};
			if (socket) socket.write(encodeTextFrame(body.text ?? ""));
			res.end("ok");
			return;
		}
		const wsClose = url.pathname.match(/^\/__ws\/([^/]+)\/close$/);
		if (wsClose && req.method === "POST") {
			const id = wsClose[1] ?? "";
			const socket = sockets.get(id);
			sockets.delete(id);
			socket?.end();
			res.end("ok");
			return;
		}
		const id = crypto.randomUUID();
		const body = await readBody(req);
		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries(req.headers)) {
			if (value === undefined) continue;
			headers[key] = Array.isArray(value) ? value.join(", ") : value;
		}
		httpPending.set(id, res);
		enqueue({
			kind: "http",
			id,
			method: req.method ?? "GET",
			path: `${url.pathname}${url.search}`,
			headers,
			bodyB64: body.toString("base64"),
		});
	}

	server.on("upgrade", (req, socket) => {
		const key = req.headers["sec-websocket-key"];
		if (typeof key !== "string") {
			socket.destroy();
			return;
		}
		const accept = createHash("sha1")
			.update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
			.digest("base64");
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);
		const id = crypto.randomUUID();
		sockets.set(id, socket);
		const url = new URL(req.url ?? "/ws", "http://127.0.0.1");
		enqueue({ kind: "ws-open", id, path: `${url.pathname}${url.search}` });
		let buffer = Buffer.alloc(0);
		socket.on("data", (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			const decoded = decodeFrames(buffer);
			buffer = decoded.rest;
			for (const frame of decoded.frames) {
				if (frame.opcode === 0x8) {
					enqueue({ kind: "ws-close", id });
					sockets.delete(id);
					socket.end();
					return;
				}
				if (frame.opcode === 0x9) {
					socket.write(encodeFrame(0xa, frame.payload));
					continue;
				}
				if (frame.opcode === 0x1) {
					enqueue({
						kind: "ws-frame",
						id,
						text: frame.payload.toString("utf8"),
					});
				}
			}
		});
		socket.on("close", () => {
			if (sockets.delete(id)) enqueue({ kind: "ws-close", id });
		});
		socket.on("error", () => {
			if (sockets.delete(id)) enqueue({ kind: "ws-close", id });
		});
	});

	const port = await new Promise<number>((resolvePort, reject) => {
		server.once("error", reject);
		server.listen(0, DAEMON_BRIDGE_HOST, () => {
			server.unref();
			const addr = server.address();
			if (addr && typeof addr === "object") resolvePort(addr.port);
			else reject(new Error("cli bridge has no port"));
		});
	});

	return {
		port,
		close: async () => {
			for (const proc of procs.values()) {
				if (proc.code === null) proc.child.kill("SIGKILL");
			}
			for (const socket of sockets.values()) socket.destroy();
			server.closeAllConnections?.();
			await new Promise<void>((done) => server.close(() => done()));
		},
	};
}

function encodeTextFrame(text: string): Buffer {
	return encodeFrame(0x1, Buffer.from(text));
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
	const len = payload.length;
	let header: Buffer;
	if (len < 126) {
		header = Buffer.from([0x80 | opcode, len]);
	} else if (len < 65536) {
		header = Buffer.alloc(4);
		header[0] = 0x80 | opcode;
		header[1] = 126;
		header.writeUInt16BE(len, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x80 | opcode;
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(len), 2);
	}
	return Buffer.concat([header, payload]);
}

function decodeFrames(buffer: Buffer): {
	frames: { opcode: number; payload: Buffer }[];
	rest: Buffer;
} {
	const frames: { opcode: number; payload: Buffer }[] = [];
	let offset = 0;
	while (offset + 2 <= buffer.length) {
		const opcode = buffer[offset] & 0x0f;
		const masked = (buffer[offset + 1] & 0x80) !== 0;
		let length = buffer[offset + 1] & 0x7f;
		let header = 2;
		if (length === 126) {
			if (offset + 4 > buffer.length) break;
			length = buffer.readUInt16BE(offset + 2);
			header = 4;
		} else if (length === 127) {
			if (offset + 10 > buffer.length) break;
			length = Number(buffer.readBigUInt64BE(offset + 2));
			header = 10;
		}
		const maskLen = masked ? 4 : 0;
		if (offset + header + maskLen + length > buffer.length) break;
		const mask = masked
			? buffer.subarray(offset + header, offset + header + 4)
			: undefined;
		const start = offset + header + maskLen;
		const payload = Buffer.from(buffer.subarray(start, start + length));
		if (mask) {
			for (let i = 0; i < payload.length; i += 1) {
				payload[i] ^= mask[i % 4] ?? 0;
			}
		}
		frames.push({ opcode, payload });
		offset = start + length;
	}
	return { frames, rest: buffer.subarray(offset) };
}
