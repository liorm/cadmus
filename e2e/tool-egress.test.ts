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

describe("egress and virtual file tools on a turn", () => {
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

			const page = await tool(
				account,
				"bot:fetcher",
				'[tool:web.fetch {"url":"https://cadmus-coverage.test/page"}]',
			);
			expect(page).toContain("Hello world");
			expect(page).not.toContain("secret()");
			expect(page).not.toContain("color:red");

			const plain = await tool(
				account,
				"bot:fetcher",
				'[tool:web.fetch {"url":"http://cadmus-coverage.test/plain"}]',
			);
			expect(plain).toContain("plain body");

			const missing = await tool(
				account,
				"bot:fetcher",
				'[tool:web.fetch {"url":"https://cadmus-coverage.test/missing"}]',
			);
			expect(missing).toContain("HTTP 404");

			const boom = await tool(
				account,
				"bot:fetcher",
				'[tool:web.fetch {"url":"https://cadmus-coverage.test/boom"}]',
			);
			expect(boom).toContain("network down");

			const badUrl = await tool(
				account,
				"bot:fetcher",
				'[tool:web.fetch {"url":"not a url"}]',
			);
			expect(badUrl).toContain("Invalid URL");

			const ftp = await tool(
				account,
				"bot:fetcher",
				'[tool:web.fetch {"url":"ftp://cadmus-coverage.test/file"}]',
			);
			expect(ftp).toContain("Only http: and https:");

			for (const call of [
				'[tool:web.search {"query":"cadmus"}]',
				'[tool:x.search {"query":"cadmus"}]',
				'[tool:code.execute {"code":"print(1)"}]',
			]) {
				const reply = await tool(account, "bot:fetcher", call);
				expect(reply).toContain('is not available on provider "faux"');
			}
		} finally {
			globalThis.fetch = originalFetch;
		}
	}, 60_000);

	it("reads, writes, edits, and deletes the bot's own /.cadmus/* skills and memory", async () => {
		const account = await scope("skill-tools");
		await sendRpc(
			"bot.create",
			{ slug: "scribe", name: "Scribe", model: "faux/echo" },
			account,
		);

		const missing = await tool(
			account,
			"bot:scribe",
			'[tool:read {"path":"/.cadmus/skills/missing/SKILL.md"}]',
		);
		expect(missing).toContain("not found");

		const badSlug = await tool(
			account,
			"bot:scribe",
			'[tool:read {"path":"/.cadmus/skills/Bad Slug/SKILL.md"}]',
		);
		expect(badSlug).toContain("Invalid skill slug");

		const created = await tool(
			account,
			"bot:scribe",
			`[tool:write ${JSON.stringify({
				path: "/.cadmus/skills/note/SKILL.md",
				content: "---\nname: note\ndescription: A note\n---\n\nhello",
			})}]`,
		);
		expect(created).toContain(
			"Successfully wrote to /.cadmus/skills/note/SKILL.md",
		);

		const withCategory = await tool(
			account,
			"bot:scribe",
			`[tool:write ${JSON.stringify({
				path: "/.cadmus/skills/note/SKILL.md",
				content:
					"---\nname: note\ndescription: A note\ncategory: ops\n---\n\nhello 2",
			})}]`,
		);
		expect(withCategory).toContain("Successfully wrote");

		const read = await tool(
			account,
			"bot:scribe",
			'[tool:read {"path":"/.cadmus/skills/note/SKILL.md"}]',
		);
		expect(read).toContain("category: ops");
		expect(read).toContain("hello 2");

		const edited = await tool(
			account,
			"bot:scribe",
			`[tool:edit ${JSON.stringify({
				path: "/.cadmus/skills/note/SKILL.md",
				edits: [{ oldText: "hello 2", newText: "edited body" }],
			})}]`,
		);
		expect(edited).toContain("Successfully replaced");

		const readEdited = await tool(
			account,
			"bot:scribe",
			'[tool:read {"path":"/.cadmus/skills/note/SKILL.md"}]',
		);
		expect(readEdited).toContain("edited body");

		const deleted = await tool(
			account,
			"bot:scribe",
			'[tool:delete {"path":"/.cadmus/skills/note/SKILL.md"}]',
		);
		expect(deleted).toContain(
			"Successfully deleted /.cadmus/skills/note/SKILL.md",
		);

		const gone = await tool(
			account,
			"bot:scribe",
			'[tool:read {"path":"/.cadmus/skills/note/SKILL.md"}]',
		);
		expect(gone).toContain("not found");

		const remembered = await tool(
			account,
			"bot:scribe",
			'[tool:write {"path":"/.cadmus/MEMORY.md","content":"remember this"}]',
		);
		expect(remembered).toContain("Successfully wrote to /.cadmus/MEMORY.md");

		const readMem = await tool(
			account,
			"bot:scribe",
			'[tool:read {"path":"/.cadmus/MEMORY.md"}]',
		);
		expect(readMem).toContain("remember this");

		const badMemFrontmatter = await tool(
			account,
			"bot:scribe",
			'[tool:write {"path":"/.cadmus/MEMORY.md","content":"---\\nfoo: bar\\n---\\n"}]',
		);
		expect(badMemFrontmatter).toContain("YAML frontmatter");
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
