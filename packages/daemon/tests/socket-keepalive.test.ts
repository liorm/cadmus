import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { runDaemon } from "../src/cli.js";
import { openDaemonSocket } from "../src/socket.js";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function acceptUpgradeHeader(key: string): string {
	const accept = createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
	return [
		"HTTP/1.1 101 Switching Protocols",
		"Upgrade: websocket",
		"Connection: Upgrade",
		`Sec-WebSocket-Accept: ${accept}`,
		"",
		"",
	].join("\r\n");
}

describe("daemon socket keepalive and reconnect", () => {
	it("closes the socket when a silent peer ignores WebSocket pings", async () => {
		const sockets: import("node:net").Socket[] = [];
		const server = createServer((sock) => {
			sockets.push(sock);
			let upgraded = false;
			sock.on("data", (chunk) => {
				if (upgraded) return;
				const text = chunk.toString("utf8");
				const match = /Sec-WebSocket-Key:\s*([^\r\n]+)/i.exec(text);
				if (match) {
					upgraded = true;
					sock.write(acceptUpgradeHeader(match[1].trim()));
				}
			});
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address();
		if (!address || typeof address === "string") {
			throw new Error("expected tcp address");
		}
		try {
			const opened = await openDaemonSocket({
				url: `ws://127.0.0.1:${address.port}/tools-env/ws?envId=ld_test`,
				headers: { Authorization: "Bearer test" },
				pingIntervalMs: 30,
				pongTimeoutMs: 40,
			});
			expect(opened.status).toBe(101);
			expect(opened.socket).toBeDefined();
			let closed = false;
			opened.socket?.onClose(() => {
				closed = true;
			});
			await opened.socket?.closed;
			expect(closed).toBe(true);
		} finally {
			for (const sock of sockets) sock.destroy();
			server.close();
		}
	});

	it("reconnects automatically when a silent socket times out and aborts cleanly on signal", async () => {
		const controller = new AbortController();
		let connections = 0;
		const serverSockets: import("node:net").Socket[] = [];
		const server = createServer((sock) => {
			serverSockets.push(sock);
			let upgraded = false;
			sock.on("data", (chunk) => {
				if (upgraded) return;
				const text = chunk.toString("utf8");
				const match = /Sec-WebSocket-Key:\s*([^\r\n]+)/i.exec(text);
				if (match) {
					upgraded = true;
					connections += 1;
					sock.write(acceptUpgradeHeader(match[1].trim()));
					if (connections >= 2) {
						controller.abort();
					}
				}
			});
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address();
		if (!address || typeof address === "string") {
			throw new Error("expected tcp address");
		}
		try {
			await runDaemon({
				url: `ws://127.0.0.1:${address.port}/tools-env/ws`,
				token: "test",
				envId: "ld_test",
				workspacePath: process.cwd(),
				persist: true,
				confineToWorkspace: false,
				signal: controller.signal,
				dial: (input) =>
					openDaemonSocket({
						...input,
						pingIntervalMs: 25,
						pongTimeoutMs: 35,
					}),
			});
			expect(connections).toBeGreaterThanOrEqual(2);
		} finally {
			for (const sock of serverSockets) sock.destroy();
			server.close();
		}
	});
});
