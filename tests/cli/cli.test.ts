import { env, SELF } from "cloudflare:test";
import { API_ROUTES } from "@cadmus/contract/routes";
import { describe, expect, it } from "vitest";
import { uniqueAccountId } from "../../packages/worker/tests/helpers.js";

const FIXTURE_TOKEN = "cli-fixture-token";

import { DAEMON_BRIDGE_HOST } from "../daemon/daemon-bridge-port.js";

interface Job {
	kind: "http" | "ws-open" | "ws-frame" | "ws-close";
	id: string;
	method?: string;
	path?: string;
	headers?: Record<string, string>;
	bodyB64?: string;
	text?: string;
}

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

function bridgeBase(): string {
	const port = env.CADMUS_CLI_BRIDGE_PORT ?? "";
	if (!port || port === "0") throw new Error("cli bridge is not running");
	return `http://${DAEMON_BRIDGE_HOST}:${port}`;
}

const sockets = new Map<string, WebSocket>();
const waiters = new Map<string, (result: RunResult) => void>();
let pumping = false;

function ensurePump(): void {
	if (pumping) return;
	pumping = true;
	void (async () => {
		while (pumping) {
			try {
				await pumpOnce();
			} catch {
				await delay(20);
			}
		}
	})();
}

async function pumpOnce(): Promise<void> {
	const base = bridgeBase();
	const pull = await fetch(`${base}/__pull`);
	if (pull.status === 200) {
		const job = (await pull.json()) as Job;
		await dispatch(base, job);
	}
	for (const [id, resolve] of [...waiters]) {
		const snap = await snapshot(id);
		if (typeof snap.code === "number") {
			waiters.delete(id);
			resolve(snap as RunResult);
		}
	}
}

async function snapshot(
	id: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const res = await fetch(`${bridgeBase()}/__cli/${id}`);
	return (await res.json()) as {
		code: number | null;
		stdout: string;
		stderr: string;
	};
}

async function dispatch(base: string, job: Job): Promise<void> {
	if (job.kind === "http") {
		const headers = new Headers();
		for (const [key, value] of Object.entries(job.headers ?? {})) {
			const lower = key.toLowerCase();
			if (
				lower === "authorization" ||
				lower === "content-type" ||
				lower === "x-account-id" ||
				lower === "x-cadmus-family-id" ||
				lower === "x-user-id"
			) {
				headers.set(key, value);
			}
		}
		const method = job.method ?? "GET";
		const init: RequestInit = { method, headers };
		if (method !== "GET" && method !== "HEAD" && job.bodyB64) {
			init.body = Uint8Array.from(atob(job.bodyB64), (char) =>
				char.charCodeAt(0),
			);
		}
		const res = await SELF.fetch(`http://example.com${job.path ?? "/"}`, init);
		const bytes = new Uint8Array(await res.arrayBuffer());
		await fetch(`${base}/__reply/${job.id}`, {
			method: "POST",
			headers: {
				"x-status": String(res.status),
				"x-content-type": res.headers.get("content-type") ?? "application/json",
			},
			body: bytes,
		});
		return;
	}
	if (job.kind === "ws-open") {
		const res = await SELF.fetch(`http://example.com${job.path ?? "/ws"}`, {
			headers: { Upgrade: "websocket" },
		});
		const ws = res.webSocket;
		if (!ws) {
			await fetch(`${base}/__ws/${job.id}/close`, { method: "POST" });
			return;
		}
		ws.accept();
		sockets.set(job.id, ws);
		ws.addEventListener("message", (ev) => {
			const text =
				typeof ev.data === "string"
					? ev.data
					: new TextDecoder().decode(ev.data as ArrayBuffer);
			void fetch(`${base}/__ws/${job.id}/frame`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text }),
			});
		});
		ws.addEventListener("close", () => {
			sockets.delete(job.id);
			void fetch(`${base}/__ws/${job.id}/close`, { method: "POST" });
		});
		return;
	}
	if (job.kind === "ws-frame") {
		sockets.get(job.id)?.send(job.text ?? "");
		return;
	}
	const ws = sockets.get(job.id);
	sockets.delete(job.id);
	try {
		ws?.close();
	} catch {
		// Already closed.
	}
}

async function start(
	args: string[],
	stdin?: string,
): Promise<{ id: string; done: Promise<RunResult> }> {
	ensurePump();
	const started = (await (
		await fetch(`${bridgeBase()}/__cli/start`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ args, stdin }),
		})
	).json()) as { id: string };
	const done = new Promise<RunResult>((resolve) => {
		waiters.set(started.id, resolve);
	});
	return { id: started.id, done };
}

async function run(args: string[], stdin?: string): Promise<RunResult> {
	const proc = await start(args, stdin);
	return proc.done;
}

async function signal(id: string, name: string): Promise<void> {
	await fetch(`${bridgeBase()}/__cli/${id}/signal`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ signal: name }),
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function baseArgs(accountId: string): string[] {
	return [
		"--url",
		bridgeBase(),
		"--token",
		FIXTURE_TOKEN,
		"--account",
		accountId,
		"--family",
		"default",
	];
}

async function until(
	read: () => Promise<boolean>,
	label: string,
): Promise<void> {
	for (let i = 0; i < 80; i += 1) {
		if (await read()) return;
		await delay(25);
	}
	throw new Error(`timed out waiting for ${label}`);
}

describe("cadmus CLI", () => {
	it("creates a bot, writes a file from stdin, and reads it back", async () => {
		const accountId = uniqueAccountId("cli-files");
		const created = await run([
			...baseArgs(accountId),
			"bot.create",
			"--slug",
			"scribe",
			"--name",
			"Scribe",
			"--model",
			"faux/echo",
		]);
		expect(created.code, created.stderr).toBe(0);
		expect(JSON.parse(created.stdout).bot.id).toBe("scribe");

		const written = await run(
			[...baseArgs(accountId), "file.write", "--payload", "-"],
			JSON.stringify({
				botId: "scribe",
				path: "MEMORY.md",
				content: "from stdin",
			}),
		);
		expect(written.code, written.stderr).toBe(0);

		const read = await run([
			...baseArgs(accountId),
			"file.read",
			"--botId",
			"scribe",
			"--path",
			"MEMORY.md",
		]);
		expect(read.code, read.stderr).toBe(0);
		expect(JSON.parse(read.stdout).content).toBe("from stdin");
	});

	it("sends a turn and streams NDJSON deltas", async () => {
		const accountId = uniqueAccountId("cli-send");
		expect(
			(
				await run([
					...baseArgs(accountId),
					"bot.create",
					"--slug",
					"echo",
					"--name",
					"Echo",
					"--model",
					"faux/echo",
				])
			).code,
		).toBe(0);
		expect(
			(
				await run([
					...baseArgs(accountId),
					"chat.create",
					"--botId",
					"echo",
					"--key",
					"main",
				])
			).code,
		).toBe(0);
		const quiet = await run([...baseArgs(accountId), "send", "main", "Hello"]);
		expect(quiet.code, quiet.stderr).toBe(0);
		expect(JSON.parse(quiet.stdout).reply).toContain("Hello");

		const streamed = await run([
			...baseArgs(accountId),
			"send",
			"main",
			"Hello",
			"--stream",
		]);
		expect(streamed.code, streamed.stderr).toBe(0);
		const lines = streamed.stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type?: string; reply?: string });
		expect(lines.some((line) => line.type === "turn.delta")).toBe(true);
		expect(lines[lines.length - 1]?.reply).toContain("Hello");
	});

	it("captures a group-chat bot.message with events", async () => {
		const accountId = uniqueAccountId("cli-events");
		expect(
			(
				await run([
					...baseArgs(accountId),
					"bot.create",
					"--slug",
					"coordinator",
					"--name",
					"Coordinator",
					"--model",
					"faux/echo",
				])
			).code,
		).toBe(0);
		expect(
			(
				await run([
					...baseArgs(accountId),
					"bot.create",
					"--slug",
					"chef",
					"--name",
					"Chef",
					"--model",
					"faux/echo",
				])
			).code,
		).toBe(0);
		expect(
			(
				await run([
					...baseArgs(accountId),
					"chat.create",
					"--botId",
					"coordinator",
					"--key",
					"coord",
				])
			).code,
		).toBe(0);
		const events = await start([
			...baseArgs(accountId),
			"events",
			"--types",
			"bot.message",
		]);
		await until(async () => sockets.size > 0, "events socket");
		const text = `Ask [tool:message_bot ${JSON.stringify({
			botId: "chef",
			topic: "pasta",
			text: '[[group-reply]][tool:end_conversation {"response":"al dente"}][[/group-reply]]',
		})}]`;
		const turned = await run([
			...baseArgs(accountId),
			"turn.submit",
			"--chatKey",
			"coord",
			"--text",
			text,
		]);
		expect(turned.code, turned.stderr).toBe(0);
		await until(async () => {
			const snap = await snapshot(events.id);
			return snap.stdout.includes("bot.message");
		}, "bot.message");
		await signal(events.id, "SIGINT");
		const finished = await events.done;
		expect(finished.code).toBe(0);
		const line = finished.stdout
			.trim()
			.split("\n")
			.map(
				(item) =>
					JSON.parse(item) as {
						type: string;
						payload?: { groupChatKey?: string };
					},
			)
			.find((item) => item.type === "bot.message");
		expect(line?.payload?.groupChatKey).toBeTruthy();
	});

	it("creates, lists, and deletes a schedule", async () => {
		const accountId = uniqueAccountId("cli-sched");
		expect(
			(
				await run([
					...baseArgs(accountId),
					"bot.create",
					"--slug",
					"timer",
					"--name",
					"Timer",
					"--model",
					"faux/echo",
				])
			).code,
		).toBe(0);
		expect(
			(
				await run([
					...baseArgs(accountId),
					"chat.create",
					"--botId",
					"timer",
					"--key",
					"ticks",
				])
			).code,
		).toBe(0);
		const created = await run([
			...baseArgs(accountId),
			"schedule.create",
			"--id",
			"wake",
			"--botId",
			"timer",
			"--kind",
			"absolute",
			"--input",
			String(Date.now() + 86_400_000),
			"--text",
			"ping",
			"--target.mode",
			"chat",
			"--target.chatKey",
			"ticks",
		]);
		expect(created.code, created.stderr).toBe(0);
		expect(JSON.parse(created.stdout).schedule.id).toBe("wake");
		const listed = await run([
			...baseArgs(accountId),
			"schedule.list",
			"--botId",
			"timer",
		]);
		expect(listed.code, listed.stderr).toBe(0);
		expect(
			JSON.parse(listed.stdout).schedules.some(
				(schedule: { id: string }) => schedule.id === "wake",
			),
		).toBe(true);
		const deleted = await run([
			...baseArgs(accountId),
			"schedule.delete",
			"--id",
			"wake",
		]);
		expect(deleted.code, deleted.stderr).toBe(0);
		const after = await run([
			...baseArgs(accountId),
			"schedule.list",
			"--botId",
			"timer",
		]);
		expect(
			JSON.parse(after.stdout).schedules.some(
				(schedule: { id: string }) => schedule.id === "wake",
			),
		).toBe(false);
	});

	it("uses exit codes 1, 2, and 3", async () => {
		const accountId = uniqueAccountId("cli-err");
		const usage = await run(["--url", bridgeBase()]);
		expect(usage.code).toBe(2);
		expect(JSON.parse(usage.stderr).code).toBe("usage");

		const unknown = await run([...baseArgs(accountId), "not.a.command"]);
		expect(unknown.code).toBe(2);

		const missingToken = await run([
			"bot.list",
			"--url",
			"http://example.test",
		]);
		expect(missingToken.code).toBe(3);
		expect(JSON.parse(missingToken.stderr).code).toBe("unauthorized");

		const protocol = await run([
			...baseArgs(accountId),
			"file.read",
			"--botId",
			"missing",
			"--path",
			"NOPE.md",
		]);
		expect(protocol.code).toBe(1);
		expect(JSON.parse(protocol.stderr).code).not.toBe("usage");
	});

	it("prints --version and exposes every RPC in commands, --help, and --skill", async () => {
		const version = await run(["--version"]);
		expect(version.code).toBe(0);
		expect(version.stdout.trim()).toBe("0.1.0");

		const accountId = uniqueAccountId("cli-enum");
		const catalog = await run([...baseArgs(accountId), "commands"]);
		expect(catalog.code).toBe(0);
		const names = new Set(
			(JSON.parse(catalog.stdout) as { name: string }[]).map(
				(item) => item.name,
			),
		);
		const skill = await run(["--skill"]);
		expect(skill.code).toBe(0);
		for (const name of Object.keys(API_ROUTES)) {
			expect(names.has(name), name).toBe(true);
			expect(skill.stdout).toContain(`\`${name}\``);
			const help = await run([...baseArgs(accountId), name, "--help"]);
			expect(help.code, help.stderr).toBe(0);
			const body = JSON.parse(help.stdout) as {
				name: string;
				method: string;
				description: string;
			};
			expect(body.name).toBe(name);
			expect(body.method === "GET" || body.method === "POST").toBe(true);
			expect(body.description.length).toBeGreaterThan(0);
		}
	}, 120_000);
});
