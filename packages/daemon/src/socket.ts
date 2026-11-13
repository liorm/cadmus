import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

/** Handshake budget. A hung SYN or a silent peer uses the same backoff as a refused dial. */
export const DAEMON_CONNECT_TIMEOUT_MS = 10_000;
/** Interval between WebSocket ping frames to detect silent/dropped connections. */
export const DAEMON_PING_INTERVAL_MS = 25_000;
/** Budget to receive any frame (including pong) after sending a WebSocket ping. */
export const DAEMON_PONG_TIMEOUT_MS = 10_000;

export interface DaemonSocket {
	send(text: string): void;
	close(): void;
	onMessage(listener: (text: string) => void): void;
	onClose(listener: () => void): void;
	readonly closed: Promise<void>;
}

export async function openDaemonSocket(input: {
	url: string;
	headers: Record<string, string>;
	timeoutMs?: number;
	pingIntervalMs?: number;
	pongTimeoutMs?: number;
}): Promise<{ status: number; socket?: DaemonSocket; error?: string }> {
	const url = new URL(input.url);
	const secure = url.protocol === "wss:" || url.protocol === "https:";
	const port = Number(url.port || (secure ? 443 : 80));
	const path = `${url.pathname}${url.search}`;
	const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString(
		"base64",
	);
	const headerLines = [
		`GET ${path} HTTP/1.1`,
		`Host: ${url.host}`,
		"Upgrade: websocket",
		"Connection: Upgrade",
		`Sec-WebSocket-Key: ${key}`,
		"Sec-WebSocket-Version: 13",
		...Object.entries(input.headers).map(
			([name, value]) => `${name}: ${value}`,
		),
		"",
		"",
	];
	const raw = secure
		? tlsConnect({ host: url.hostname, port, servername: url.hostname })
		: netConnect({ host: url.hostname, port });
	const timeoutMs = input.timeoutMs ?? DAEMON_CONNECT_TIMEOUT_MS;
	return new Promise((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			fail(new Error("connect timeout"));
		}, timeoutMs);
		const onHandshakeClose = () => {
			fail(new Error("socket closed before handshake"));
		};
		const fail = (error: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			raw.off("error", fail);
			raw.off("close", onHandshakeClose);
			raw.on("error", () => {});
			raw.destroy();
			reject(error instanceof Error ? error : new Error(String(error)));
		};
		const succeed = (value: {
			status: number;
			socket?: DaemonSocket;
			error?: string;
		}) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			raw.off("error", fail);
			raw.off("close", onHandshakeClose);
			resolve(value);
		};
		raw.once("error", fail);
		raw.once("close", onHandshakeClose);
		raw.once("connect", () => {
			raw.setKeepAlive?.(true, 15_000);
			raw.write(headerLines.join("\r\n"));
			let buf = Buffer.alloc(0);
			const onData = (chunk: Buffer) => {
				buf = Buffer.concat([buf, chunk]);
				const split = buf.indexOf("\r\n\r\n");
				if (split < 0) return;
				raw.off("data", onData);
				const head = buf.subarray(0, split).toString("utf8");
				const status = Number(/^HTTP\/1\.[01] (\d+)/.exec(head)?.[1] ?? 0);
				const rest = buf.subarray(split + 4);
				if (status !== 101) {
					raw.end();
					const bodyText = rest.toString("utf8").trim();
					succeed({ status, error: bodyText || undefined });
					return;
				}
				succeed({
					status,
					socket: wrapSocket(raw, rest, {
						pingIntervalMs: input.pingIntervalMs,
						pongTimeoutMs: input.pongTimeoutMs,
					}),
				});
			};
			raw.on("data", onData);
		});
	});
}

function wrapSocket(
	raw: Socket,
	initial: Buffer,
	options?: { pingIntervalMs?: number; pongTimeoutMs?: number },
): DaemonSocket {
	let buf = Buffer.from(initial);
	let closed = false;
	const messages: Array<(text: string) => void> = [];
	const closes: Array<() => void> = [];
	let resolveClosed: () => void = () => {};
	const closedPromise = new Promise<void>((resolve) => {
		resolveClosed = resolve;
	});
	const pingIntervalMs = options?.pingIntervalMs ?? DAEMON_PING_INTERVAL_MS;
	const pongTimeoutMs = options?.pongTimeoutMs ?? DAEMON_PONG_TIMEOUT_MS;
	let pingTimer: ReturnType<typeof setInterval> | null = null;
	let pongTimer: ReturnType<typeof setTimeout> | null = null;
	const clearPongTimer = () => {
		if (!pongTimer) return;
		clearTimeout(pongTimer);
		pongTimer = null;
	};
	const finish = () => {
		if (closed) return;
		closed = true;
		if (pingTimer) {
			clearInterval(pingTimer);
			pingTimer = null;
		}
		clearPongTimer();
		resolveClosed();
		for (const listener of closes) listener();
		raw.destroy();
	};
	const sendFrame = (opcode: number, payload: Buffer) => {
		if (closed) return;
		const mask = crypto.getRandomValues(new Uint8Array(4));
		const masked = Buffer.alloc(payload.length);
		for (let index = 0; index < payload.length; index += 1) {
			masked[index] = payload[index] ^ mask[index % 4];
		}
		const header: number[] = [0x80 | opcode];
		if (payload.length < 126) header.push(0x80 | payload.length);
		else if (payload.length < 65536) {
			header.push(
				0x80 | 126,
				(payload.length >> 8) & 0xff,
				payload.length & 0xff,
			);
		} else {
			const length = BigInt(payload.length);
			header.push(0x80 | 127);
			for (let shift = 56; shift >= 0; shift -= 8) {
				header.push(Number((length >> BigInt(shift)) & 0xffn));
			}
		}
		raw.write(Buffer.concat([Buffer.from(header), Buffer.from(mask), masked]));
	};
	const pump = () => {
		while (buf.length >= 2) {
			const opcode = buf[0] & 0x0f;
			const masked = (buf[1] & 0x80) !== 0;
			let length = buf[1] & 0x7f;
			let offset = 2;
			if (length === 126) {
				if (buf.length < 4) return;
				length = buf.readUInt16BE(2);
				offset = 4;
			} else if (length === 127) {
				if (buf.length < 10) return;
				length = Number(buf.readBigUInt64BE(2));
				offset = 10;
			}
			const maskLen = masked ? 4 : 0;
			if (buf.length < offset + maskLen + length) return;
			let payload = buf.subarray(offset + maskLen, offset + maskLen + length);
			if (masked) {
				const mask = buf.subarray(offset, offset + 4);
				const copy = Buffer.from(payload);
				for (let index = 0; index < copy.length; index += 1) {
					copy[index] ^= mask[index % 4];
				}
				payload = copy;
			}
			buf = buf.subarray(offset + maskLen + length);
			if (opcode === 0x1) {
				const text = payload.toString("utf8");
				for (const listener of messages) listener(text);
			} else if (opcode === 0x8) {
				finish();
				return;
			} else if (opcode === 0x9) {
				sendFrame(0x0a, payload);
			}
		}
	};
	raw.on("data", (chunk: Buffer) => {
		clearPongTimer();
		buf = Buffer.concat([buf, chunk]);
		pump();
	});
	raw.on("close", finish);
	raw.on("error", finish);
	if (pingIntervalMs > 0) {
		pingTimer = setInterval(() => {
			if (closed) return;
			sendFrame(0x9, Buffer.alloc(0));
			if (pongTimeoutMs > 0 && !pongTimer) {
				pongTimer = setTimeout(() => {
					pongTimer = null;
					finish();
				}, pongTimeoutMs);
				pongTimer.unref?.();
			}
		}, pingIntervalMs);
		pingTimer.unref?.();
	}
	if (initial.length > 0) pump();
	return {
		send(text: string) {
			sendFrame(0x1, Buffer.from(text));
		},
		close() {
			if (!closed) sendFrame(0x8, Buffer.alloc(0));
			finish();
		},
		onMessage(listener) {
			messages.push(listener);
		},
		onClose(listener) {
			closes.push(listener);
		},
		closed: closedPromise,
	};
}
