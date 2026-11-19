import http from "node:http";

export const MASTER_TOKEN = "parked-ui-token";

export function uniqueAccountId(prefix = "ui"): string {
	return `${prefix}-${crypto.randomUUID()}`;
}

export interface ProxyPostResponse {
	ok: boolean;
	status: number;
	text: string;
}

class TransientProxyDropError extends Error {}

/**
 * wrangler dev's local ProxyWorker occasionally drops a POST keep-alive
 * socket under parallel load and responds with plain-text 500
 * "Error: Network connection lost.". Throw only for that transient drop.
 */
export function throwOnProxyDrop(status: number, text: string): void {
	if (status >= 500 && text.includes("Network connection lost")) {
		throw new TransientProxyDropError(text);
	}
}

/**
 * Retries transient `wrangler dev` ProxyWorker socket drops (`TransientProxyDropError`
 * or `fetch` `TypeError`) up to 3 attempts with linear backoff.
 */
export async function retryProxyDrop<T>(fn: () => Promise<T>): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error;
			const retryable =
				error instanceof TransientProxyDropError || error instanceof TypeError;
			if (!retryable || attempt >= 2) throw error;
			await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
		}
	}
	throw lastError;
}

/**
 * Executes an RPC POST via a caller-provided transport (`fetch` or Playwright
 * `APIRequestContext`), retrying transient proxy drops and throwing on errors.
 */
export async function executeRpcPost<T>(
	type: string,
	post: () => Promise<ProxyPostResponse>,
): Promise<T> {
	return retryProxyDrop(async () => {
		const res = await post();
		let body: {
			ok?: boolean;
			result?: T;
			error?: { code?: string; message?: string };
		};
		try {
			body = JSON.parse(res.text) as typeof body;
		} catch {
			throwOnProxyDrop(res.status, res.text);
			throw new Error(
				`${type} returned non-JSON (${res.status}): ${res.text.slice(0, 200)}`,
			);
		}
		if (!res.ok || body.ok === false) {
			const code = body.error?.code ? `${body.error.code} ` : "";
			throw new Error(
				`${type} failed: ${res.status} ${code}${body.error?.message ?? JSON.stringify(body)}`,
			);
		}
		return body.result as T;
	});
}

export async function sendAccountRpc<T = unknown>(
	baseUrl: string,
	accountId: string,
	type: string,
	payload: Record<string, unknown> = {},
	userId = "owner",
): Promise<T> {
	const init: RequestInit = {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${MASTER_TOKEN}`,
			"x-account-id": accountId,
			"x-user-id": userId,
		},
		body: JSON.stringify({ id: `ui-${crypto.randomUUID()}`, type, payload }),
	};
	return executeRpcPost<T>(type, async () => {
		const res = await fetch(`${baseUrl}/rpc`, init);
		return { ok: res.ok, status: res.status, text: await res.text() };
	});
}

export async function provisionAccount(
	baseUrl: string,
	accountId: string,
	userId = "owner",
): Promise<void> {
	await sendAccountRpc(baseUrl, accountId, "bot.list", {}, userId);
}

export async function seedBot(
	baseUrl: string,
	accountId: string,
	name: string,
	slug: string,
): Promise<{ id: string; name: string }> {
	const result = await sendAccountRpc<{ bot: { id: string; name: string } }>(
		baseUrl,
		accountId,
		"bot.create",
		{ slug, name, model: "faux/echo" },
	);
	return result.bot;
}

export async function getBot(
	baseUrl: string,
	accountId: string,
	botId: string,
): Promise<{ model: string; tools?: string[]; timezone?: string }> {
	const result = await sendAccountRpc<{
		bot: { model: string; tools?: string[]; timezone?: string };
	}>(baseUrl, accountId, "bot.get", { botId });
	return result.bot;
}

export async function pairDaemonEnv(
	baseUrl: string,
	accountId: string,
	label = "Playwright Daemon",
): Promise<{ envId: string; token: string }> {
	const created = await sendAccountRpc<{
		env: { envId: string };
		pairingToken?: string;
	}>(baseUrl, accountId, "account.toolsEnvs.create", {
		kind: "local-daemon",
		label,
		confineToWorkspace: false,
	});
	const envId = created.env.envId;
	const pairingToken =
		created.pairingToken ??
		(
			await sendAccountRpc<{ pairingToken: string }>(
				baseUrl,
				accountId,
				"account.toolsEnvs.pair",
				{ envId },
			)
		).pairingToken;
	const res = await fetch(`${baseUrl}/tools-env/pair`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			pairingToken,
			name: label,
		}),
	});
	if (!res.ok) {
		throw new Error(`pairing failed: ${res.status} ${await res.text()}`);
	}
	const redeemed = (await res.json()) as { token: string };
	return { envId, token: redeemed.token };
}

export async function connectDaemonWs(input: {
	origin: string;
	envId: string;
	token: string;
	workspace: string;
}): Promise<{ close: () => void }> {
	const target = new URL(
		`/tools-env/ws?envId=${encodeURIComponent(input.envId)}`,
		input.origin,
	);
	const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString(
		"base64",
	);
	return new Promise((resolve, reject) => {
		const req = http.request({
			hostname: target.hostname,
			port: target.port,
			path: `${target.pathname}${target.search}`,
			method: "GET",
			headers: {
				Connection: "Upgrade",
				Upgrade: "websocket",
				"Sec-WebSocket-Key": key,
				"Sec-WebSocket-Version": "13",
				Authorization: `Bearer ${input.token}`,
				"X-Cadmus-Workspace": input.workspace,
			},
		});
		req.on("upgrade", (_res, socket) => {
			socket.on("error", () => {});
			socket.resume();
			resolve({
				close: () => {
					socket.end();
					socket.destroy();
				},
			});
		});
		req.on("response", (res) => {
			reject(new Error(`Unexpected status ${res.statusCode}`));
		});
		req.on("error", reject);
		req.end();
	});
}
