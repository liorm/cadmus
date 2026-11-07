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
): Promise<{ model: string; tools?: string[] }> {
	const result = await sendAccountRpc<{
		bot: { model: string; tools?: string[] };
	}>(baseUrl, accountId, "bot.get", { botId });
	return result.bot;
}
