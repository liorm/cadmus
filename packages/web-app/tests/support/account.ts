import http from "node:http";

export const MASTER_TOKEN = "dev-cadmus-secret";

export function uniqueAccountId(prefix = "ui"): string {
	return `${prefix}-${crypto.randomUUID()}`;
}

export async function sendAccountRpc<T = unknown>(
	baseUrl: string,
	accountId: string,
	type: string,
	payload: Record<string, unknown> = {},
	userId = "owner",
): Promise<T> {
	const res = await fetch(`${baseUrl}/rpc`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${MASTER_TOKEN}`,
			"x-account-id": accountId,
			"x-user-id": userId,
		},
		body: JSON.stringify({ id: `ui-${crypto.randomUUID()}`, type, payload }),
	});
	const body = (await res.json()) as {
		ok?: boolean;
		result?: T;
		error?: { message?: string };
	};
	if (!res.ok || body.ok === false) {
		throw new Error(
			`${type} failed: ${res.status} ${body.error?.message ?? JSON.stringify(body)}`,
		);
	}
	return body.result as T;
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
