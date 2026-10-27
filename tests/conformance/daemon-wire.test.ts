import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import { DaemonSession } from "../../packages/daemon/src/session.js";
import { createWireExecutionEnv } from "../../packages/worker/src/tools-env/wire-env.js";

registerEnvConformance(
	{ describe, expect, it },
	"daemon wire NodeExecutionEnv",
	async (use) => {
		const cwd = await mkdtemp(join(tmpdir(), "cadmus-conf-"));
		let session: DaemonSession | undefined;
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch(req, server) {
				if (server.upgrade(req)) return undefined;
				return new Response("upgrade required", { status: 426 });
			},
			websocket: {
				open(ws) {
					const env = new NodeExecutionEnv({ cwd });
					session = new DaemonSession(env, { cwd });
					session.attach({
						send: (text) => ws.send(text),
						close: () => ws.close(),
					});
				},
				message(_ws, message) {
					session?.handleText(String(message));
				},
				close() {
					session?.dispose();
				},
			},
		});
		const client = new WebSocket(`ws://127.0.0.1:${server.port}`);
		await new Promise<void>((resolve, reject) => {
			client.onopen = () => resolve();
			client.onerror = () => reject(new Error("conformance socket failed"));
		});
		const wire = createWireExecutionEnv({
			socket: {
				send: (text) => client.send(text),
				close: () => client.close(),
			},
			id: "daemon:conformance:env",
			cwd,
		});
		client.onmessage = (event) => {
			wire.ingest(String(event.data));
		};
		try {
			await use(wire.env);
		} finally {
			wire.failAll();
			client.close();
			session?.dispose();
			server.stop(true);
			await rm(cwd, { recursive: true, force: true });
		}
	},
	{ symlinks: true, listFiles: false },
);
