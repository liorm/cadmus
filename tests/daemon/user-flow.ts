/**
 * Owner-account user flows against the local Worker. A local-daemon env is
 * paired by spawning `cadmus-daemon pair` on the host. The process dials the
 * bridge, and this helper forwards that call into the Worker's real
 * `/tools-env/pair` and `/tools-env/ws` handlers.
 */
import { env, SELF } from "cloudflare:test";
import {
	clearProviderToolCapture,
	installProviderToolCapture,
} from "../../packages/worker/src/extensions/provider-tools.js";
import {
	connectTestWs,
	type RpcOptions,
	sendRpc,
	uniqueAccountId,
} from "../../packages/worker/tests/helpers.js";

export type UserFlowPin = "chat" | "bot" | "account";
export type UserFlowKind = "local-daemon" | "just-bash";

interface BridgeAddress {
	host: string;
	port: number;
	eventPort: number;
}

function bridgeAddress(): BridgeAddress {
	const host = env.CADMUS_DAEMON_BRIDGE_HOST ?? "";
	const port = Number(env.CADMUS_DAEMON_BRIDGE_PORT);
	const eventPort = Number(env.CADMUS_DAEMON_BRIDGE_EVENT_PORT);
	if (!host || !port || !eventPort) {
		throw new Error("daemon bridge is not running for this vitest invocation");
	}
	return { host, port, eventPort };
}

interface BridgeMessage {
	type: string;
	id?: string;
	method?: string;
	path?: string;
	headers?: Record<string, string>;
	body?: string;
	text?: string;
	stream?: string;
	code?: number | null;
	port?: number;
	status?: number;
}

class DaemonLink {
	readonly logs: string[] = [];
	private readonly sockets = new Map<string, WebSocket>();
	private readonly earlyFrames = new Map<string, string[]>();
	private readonly abort = new AbortController();
	private pumping: Promise<void> = Promise.resolve();

	baseUrl = "";
	private eventBase = "";
	private controlBase = "";

	private constructor(private readonly testId: string) {}

	static async open(testId: string): Promise<DaemonLink> {
		const address = bridgeAddress();
		const controlBase = `http://${address.host}:${address.port}`;
		const res = await fetch(`${controlBase}/session`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ testId }),
		});
		if (!res.ok) {
			throw new Error(`daemon bridge session failed: ${res.status}`);
		}
		const body = (await res.json()) as { port?: number; eventPort?: number };
		if (!body.port || !body.eventPort) {
			throw new Error("daemon bridge did not assign a port");
		}
		const link = new DaemonLink(testId);
		link.controlBase = controlBase;
		link.baseUrl = `http://${address.host}:${body.port}`;
		link.eventBase = `http://${address.host}:${body.eventPort}`;
		link.pumping = link.pump();
		return link;
	}

	spawn(token: string): void {
		void this.post({ type: "spawn", token });
	}

	async stop(): Promise<void> {
		for (const socket of this.sockets.values()) {
			try {
				socket.close();
			} catch {
				// Already closed.
			}
		}
		this.sockets.clear();
		await this.post({ type: "stop" }).catch(() => undefined);
		this.abort.abort();
		await Promise.race([
			this.pumping.catch(() => undefined),
			new Promise((resolve) => setTimeout(resolve, 500)),
		]);
	}

	private async post(value: Record<string, unknown>): Promise<void> {
		await fetch(`${this.controlBase}/event`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ...value, testId: this.testId }),
		});
	}

	private async pump(): Promise<void> {
		while (!this.abort.signal.aborted) {
			let res: Response;
			try {
				res = await fetch(
					`${this.eventBase}/event?testId=${encodeURIComponent(this.testId)}`,
					{ signal: this.abort.signal },
				);
			} catch {
				return;
			}
			if (!res.ok) return;
			let message: BridgeMessage;
			try {
				message = (await res.json()) as BridgeMessage;
			} catch {
				continue;
			}
			if (message.type === "stopped") return;
			void this.onMessage(message);
		}
	}

	private async onMessage(message: BridgeMessage): Promise<void> {
		if (message.type === "log" && message.text) {
			this.logs.push(message.text);
			if (this.logs.length > 40) this.logs.shift();
			return;
		}
		if (message.type === "http" && message.id && message.path) {
			const headers = new Headers(message.headers);
			const res = await SELF.fetch(`http://example.com${message.path}`, {
				method: message.method ?? "POST",
				headers,
				body:
					message.body && message.body.length > 0 ? message.body : undefined,
			});
			const body = await res.text();
			await this.post({
				type: "http-result",
				id: message.id,
				status: res.status,
				body,
				headers: {
					"content-type": res.headers.get("content-type") ?? "application/json",
				},
			});
			return;
		}
		if (message.type === "ws-offer" && message.id && message.path) {
			const headers = new Headers(message.headers);
			headers.set("Upgrade", "websocket");
			const res = await SELF.fetch(`http://example.com${message.path}`, {
				method: "GET",
				headers,
			});
			if (res.status !== 101 || !res.webSocket) {
				const body = await res.text().catch(() => "");
				await this.post({
					type: "ws-deny",
					id: message.id,
					status: res.status,
					body,
				});
				return;
			}
			const socket = res.webSocket;
			socket.accept();
			const id = message.id;
			this.sockets.set(id, socket);
			socket.addEventListener("message", (event) => {
				const text =
					typeof event.data === "string"
						? event.data
						: new TextDecoder().decode(event.data as ArrayBuffer);
				void this.post({ type: "ws-send", id, text });
			});
			socket.addEventListener("close", () => {
				this.sockets.delete(id);
				void this.post({ type: "ws-close", id });
			});
			for (const text of this.earlyFrames.get(id) ?? []) socket.send(text);
			this.earlyFrames.delete(id);
			await this.post({ type: "ws-ready", id });
			return;
		}
		if (
			message.type === "ws-frame" &&
			message.id &&
			typeof message.text === "string"
		) {
			const socket = this.sockets.get(message.id);
			if (socket && socket.readyState === WebSocket.OPEN) {
				socket.send(message.text);
				return;
			}
			const queued = this.earlyFrames.get(message.id) ?? [];
			queued.push(message.text);
			this.earlyFrames.set(message.id, queued);
			return;
		}
		if (message.type === "ws-close" && message.id) {
			this.sockets.get(message.id)?.close();
			this.sockets.delete(message.id);
			this.earlyFrames.delete(message.id);
		}
	}
}

export interface UserFlowResult {
	accountId: string;
	envId: string;
	offeredTools: string[][];
	toolContent: string;
	toolError: boolean;
	transcript: string;
}

export async function runToolsEnvUserFlow(input: {
	label: string;
	kind: UserFlowKind;
	pin: UserFlowPin;
}): Promise<UserFlowResult> {
	const accountId = uniqueAccountId(`user-flow-${input.label}`);
	const options: RpcOptions = { accountId, familyId: "default" };
	const testId = crypto.randomUUID();
	const link =
		input.kind === "local-daemon" ? await DaemonLink.open(testId) : undefined;
	const sink = installProviderToolCapture();
	try {
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		const baseUrl = link?.baseUrl;
		const created = await sendRpc<{
			env: { envId: string };
			pairingToken?: string;
		}>(
			"account.toolsEnvs.create",
			input.kind === "local-daemon"
				? {
						kind: "local-daemon",
						label: input.label,
						persist: true,
						confineToWorkspace: false,
						baseUrl,
					}
				: {
						kind: "just-bash",
						label: input.label,
						persist: true,
					},
			options,
		);
		if (!created.frame.ok || !created.frame.result?.env.envId) {
			throw new Error(
				`env create failed: ${JSON.stringify(created.frame.error ?? created.frame)}`,
			);
		}
		const envId = created.frame.result.env.envId;
		if (input.kind === "local-daemon") {
			const token = created.frame.result.pairingToken ?? "";
			if (!token) throw new Error("pairing token missing");
			link?.spawn(token);
			await waitUntilConnected(options, envId, link);
		}
		const binding = { envId };
		if (input.pin === "account") {
			const updated = await sendRpc(
				"account.update",
				{ defaultToolsEnv: binding },
				options,
			);
			if (!updated.frame.ok) {
				throw new Error(
					`account default failed: ${JSON.stringify(updated.frame.error)}`,
				);
			}
		}
		const bot = await sendRpc(
			"bot.create",
			{
				slug: "assistant",
				name: "Assistant",
				model: "faux/echo",
				...(input.pin === "bot"
					? { toolsEnv: { enabled: true, binding } }
					: {}),
			},
			options,
		);
		if (!bot.frame.ok) {
			throw new Error(`bot create failed: ${JSON.stringify(bot.frame.error)}`);
		}
		const chat = await sendRpc(
			"chat.create",
			{
				botId: "assistant",
				key: "main",
				...(input.pin === "chat"
					? { toolsEnv: { enabled: true, binding } }
					: {}),
			},
			options,
		);
		if (!chat.frame.ok) {
			throw new Error(
				`chat create failed: ${JSON.stringify(chat.frame.error)}`,
			);
		}

		const marker = `cadmus-flow-${testId.slice(0, 8)}`;
		const command = `printf '%s' ${marker}`;
		const ws = await connectTestWs(options);
		let toolContent = "";
		let toolError = true;
		try {
			ws.events.length = 0;
			const turn = await ws.send("turn.submit", {
				chatKey: "main",
				text: `[tool:bash ${JSON.stringify({ command })}]`,
			});
			if (!turn.ok) {
				throw new Error(`turn failed: ${JSON.stringify(turn.error)}`);
			}
			const payload = ws.events.find(
				(event) => event.type === "turn.tool_result",
			)?.payload as { isError?: boolean; content?: string } | undefined;
			toolContent = payload?.content ?? "";
			toolError = payload?.isError !== false;
		} finally {
			ws.close();
		}
		const entries = await sendRpc<{ entries: unknown[] }>(
			"chat.entries",
			{ chatKey: "main" },
			options,
		);
		return {
			accountId,
			envId,
			offeredTools: sink
				.filter((entry) => entry.botId === "assistant")
				.map((entry) => entry.tools),
			toolContent,
			toolError,
			transcript: JSON.stringify(entries.frame.result?.entries ?? []),
		};
	} finally {
		clearProviderToolCapture();
		await link?.stop();
	}
}

async function waitUntilConnected(
	options: RpcOptions,
	envId: string,
	link: DaemonLink | undefined,
): Promise<void> {
	const deadline = Date.now() + 15_000;
	let last = "";
	while (Date.now() < deadline) {
		const listed = await sendRpc<{
			envs: Array<{ envId: string; connection?: { status?: string } }>;
		}>("account.toolsEnvs.list", {}, options);
		const row = listed.frame.result?.envs.find((env) => env.envId === envId);
		last = JSON.stringify(row?.connection ?? null);
		if (row?.connection?.status === "connected") return;
		await new Promise((resolve) => setTimeout(resolve, 40));
	}
	throw new Error(
		`daemon stayed ${last}. logs: ${(link?.logs ?? []).join("").slice(-2000)}`,
	);
}

export function capturesInclude(offered: string[][], name: string): boolean {
	return offered.some((tools) => tools.includes(name));
}
