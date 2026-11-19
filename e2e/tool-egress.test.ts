import { describe, expect, it } from "vitest";
import {
	adminScope,
	type ModelInfo,
	sendRpc,
	useWorkerFixture,
} from "./helpers.js";

/**
 * Tool-execute paths that only run when a turn calls them: web.fetch (egress
 * mocked), provider-native xAI tools on faux, knowledge/memory tools, and
 * model-ref checks on bot.create.
 */

type Scope = { accountId: string; familyId: string };

async function scope(_label: string): Promise<Scope> {
	return adminScope("default");
}

async function tool(
	account: Scope,
	chatKey: string,
	call: string,
): Promise<string> {
	const turn = await sendRpc<{ reply: string }>(
		"turn.submit",
		{ chatKey, text: call },
		account,
	);
	expect(turn.frame.ok, JSON.stringify(turn.frame)).toBe(true);
	return turn.frame.result?.reply ?? "";
}

function lastNumber(reply: string, field: string): number {
	const re = new RegExp(`"${field}":(\\d+)`, "g");
	let last: number | undefined;
	for (const match of reply.matchAll(re)) last = Number(match[1]);
	expect(last, reply).toBeTypeOf("number");
	return last ?? -1;
}

describe("egress and knowledge tools on a turn", () => {
	useWorkerFixture();

	it("fetches public pages and reports provider tools as unavailable on faux", async () => {
		const account = await scope("egress");
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input, init) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.toString()
						: input.url;
			if (url.startsWith("https://cadmus-coverage.test/page")) {
				return new Response(
					"<html><script>secret()</script><style>.x{color:red}</style><p>Hello   <b>world</b></p></html>",
					{ status: 200, headers: { "Content-Type": "text/html" } },
				);
			}
			if (url.startsWith("http://cadmus-coverage.test/plain")) {
				return new Response("plain body", { status: 200 });
			}
			if (url.startsWith("https://cadmus-coverage.test/missing")) {
				return new Response("gone", { status: 404, statusText: "Not Found" });
			}
			if (url.startsWith("https://cadmus-coverage.test/boom")) {
				throw new Error("network down");
			}
			return originalFetch(input, init);
		};
		try {
			await sendRpc(
				"bot.create",
				{
					slug: "fetcher",
					name: "Fetcher",
					model: "faux/echo",
					// An explicit list without bash/read/write/edit keeps the account
					// just-bash env from suppressing code.execute.
					tools: ["web.fetch", "web.search", "x.search", "code.execute"],
				},
				account,
			);
			await sendRpc("chat.create", { botId: "fetcher", key: "main" }, account);

			const page = await tool(
				account,
				"main",
				'[tool:web.fetch {"url":"https://cadmus-coverage.test/page"}]',
			);
			expect(page).toContain("Hello world");
			expect(page).not.toContain("secret()");
			expect(page).not.toContain("color:red");

			const plain = await tool(
				account,
				"main",
				'[tool:web.fetch {"url":"http://cadmus-coverage.test/plain"}]',
			);
			expect(plain).toContain("plain body");

			const missing = await tool(
				account,
				"main",
				'[tool:web.fetch {"url":"https://cadmus-coverage.test/missing"}]',
			);
			expect(missing).toContain("HTTP 404");

			const boom = await tool(
				account,
				"main",
				'[tool:web.fetch {"url":"https://cadmus-coverage.test/boom"}]',
			);
			expect(boom).toContain("network down");

			const badUrl = await tool(
				account,
				"main",
				'[tool:web.fetch {"url":"not a url"}]',
			);
			expect(badUrl).toContain("Invalid URL");

			const ftp = await tool(
				account,
				"main",
				'[tool:web.fetch {"url":"ftp://cadmus-coverage.test/file"}]',
			);
			expect(ftp).toContain("Only http: and https:");

			for (const call of [
				'[tool:web.search {"query":"cadmus"}]',
				'[tool:x.search {"query":"cadmus"}]',
				'[tool:code.execute {"code":"print(1)"}]',
			]) {
				const reply = await tool(account, "main", call);
				expect(reply).toContain('is not available on provider "faux"');
			}
		} finally {
			globalThis.fetch = originalFetch;
		}
	}, 60_000);

	it("reads, updates, and deletes the bot's own knowledge and memory", async () => {
		const account = await scope("knowledge-tools");
		await sendRpc(
			"bot.create",
			{ slug: "scribe", name: "Scribe", model: "faux/echo" },
			account,
		);
		await sendRpc("chat.create", { botId: "scribe", key: "main" }, account);

		const missing = await tool(
			account,
			"main",
			'[tool:knowledge_read {"slug":"missing"}]',
		);
		expect(missing).toContain('"exists":false');
		expect(missing).toContain('"version":0');

		const badSlug = await tool(
			account,
			"main",
			'[tool:knowledge_read {"slug":"Bad Slug"}]',
		);
		expect(badSlug).toContain("Invalid knowledge slug");

		const created = await tool(
			account,
			"main",
			'[tool:knowledge_update {"slug":"note","description":"A note","body":"hello","expectedVersion":0}]',
		);
		expect(lastNumber(created, "version")).toBe(1);

		const withCategory = await tool(
			account,
			"main",
			'[tool:knowledge_update {"slug":"note","description":"A note","category":"ops","body":"hello 2","version":1}]',
		);
		expect(withCategory).toContain('"category":"ops"');
		expect(lastNumber(withCategory, "version")).toBe(2);

		const read = await tool(
			account,
			"main",
			'[tool:knowledge_read {"slug":"note"}]',
		);
		expect(read).toContain('"exists":true');
		expect(read).toContain("hello 2");

		const cleared = await tool(
			account,
			"main",
			'[tool:knowledge_update {"slug":"note","description":"A note","category":"","body":"cleared","expectedVersion":2}]',
		);
		expect(lastNumber(cleared, "version")).toBe(3);
		const clearedResult = cleared.slice(cleared.lastIndexOf("->") + 2);
		expect(clearedResult).not.toContain('"category"');

		const badVersion = await tool(
			account,
			"main",
			'[tool:knowledge_update {"slug":"note","description":"nope","body":"x","expectedVersion":-1}]',
		);
		expect(badVersion).toContain("non-negative integer");

		const stale = await tool(
			account,
			"main",
			'[tool:knowledge_update {"slug":"note","description":"stale","body":"x","expectedVersion":0}]',
		);
		expect(stale.toLowerCase()).toContain("version");

		const deleteMissingVersion = await tool(
			account,
			"main",
			'[tool:knowledge_delete {"slug":"note"}]',
		);
		expect(deleteMissingVersion).toContain("positive integer");

		const deleteStale = await tool(
			account,
			"main",
			'[tool:knowledge_delete {"slug":"note","expectedVersion":1}]',
		);
		expect(deleteStale.toLowerCase()).toContain("version");

		const deleted = await tool(
			account,
			"main",
			'[tool:knowledge_delete {"slug":"note","version":3}]',
		);
		expect(deleted).toContain('"deleted":"note"');

		const gone = await tool(
			account,
			"main",
			'[tool:knowledge_read {"slug":"note"}]',
		);
		expect(gone).toContain('"exists":false');

		const memory = await tool(account, "main", "[tool:memory_read {}]");
		expect(memory).toContain('"exists":false');

		const remembered = await tool(
			account,
			"main",
			'[tool:memory_update {"body":"remember this","version":0}]',
		);
		expect(lastNumber(remembered, "version")).toBe(1);

		const noContent = await tool(account, "main", "[tool:memory_update {}]");
		expect(noContent).toContain("content (or body) string is required");

		const badMemoryVersion = await tool(
			account,
			"main",
			'[tool:memory_update {"content":"x","expectedVersion":-1}]',
		);
		expect(badMemoryVersion).toContain("non-negative integer");

		const staleMemory = await tool(
			account,
			"main",
			'[tool:memory_update {"content":"x","expectedVersion":0}]',
		);
		expect(staleMemory.toLowerCase()).toContain("version");
	}, 60_000);

	it("rejects unknown models and accepts a provider once a key is stored", async () => {
		const account = await scope("model-check");
		const models = await sendRpc<{ models: ModelInfo[] }>(
			"account.models.list",
			{},
			account,
		);
		expect(models.frame.ok).toBe(true);
		const catalog = models.frame.result?.models ?? [];
		const anthropic = catalog.find((model) => model.provider === "anthropic");
		const xai = catalog.find((model) => model.provider === "xai");
		expect(anthropic).toBeDefined();
		expect(xai).toBeDefined();

		const unknownProvider = await sendRpc(
			"bot.create",
			{ slug: "no-provider", name: "No Provider", model: "nope/missing" },
			account,
		);
		expect(unknownProvider.frame.ok).toBe(false);
		expect(unknownProvider.frame.error?.message).toContain("Unknown provider");

		const unknownModel = await sendRpc(
			"bot.create",
			{ slug: "no-model", name: "No Model", model: "faux/missing" },
			account,
		);
		expect(unknownModel.frame.ok).toBe(false);
		expect(unknownModel.frame.error?.message).toContain("Unknown model");

		const noKey = await sendRpc(
			"bot.create",
			{
				slug: "no-key",
				name: "No Key",
				model: `${anthropic?.provider}/${anthropic?.id}`,
			},
			account,
		);
		expect(noKey.frame.ok).toBe(false);
		expect(noKey.frame.error?.message).toContain("no credentials");

		const set = await sendRpc(
			"account.credentials.set",
			{
				providerId: "xai",
				credential: { type: "api_key", apiKey: "xai-coverage-key" },
			},
			account,
		);
		expect(set.frame.ok).toBe(true);

		const authed = await sendRpc<{ bot: { model: string } }>(
			"bot.create",
			{
				slug: "with-key",
				name: "With Key",
				model: `${xai?.provider}/${xai?.id}`,
			},
			account,
		);
		expect(authed.frame.ok, JSON.stringify(authed.frame)).toBe(true);
		expect(authed.frame.result?.bot.model).toBe(`${xai?.provider}/${xai?.id}`);
	});
});
