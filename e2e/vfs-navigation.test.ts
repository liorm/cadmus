import { describe, expect, it } from "vitest";
import { adminScope, sendRpc, useWorkerFixture } from "./helpers.js";

describe("VFS navigation & search tools (ls, find, grep)", () => {
	useWorkerFixture();

	it("supports ls, find, and grep on /.cadmus/* and enforces bot isolation", async () => {
		const scope = await adminScope("default");

		await sendRpc(
			"bot.create",
			{
				slug: "navigator",
				name: "Navigator",
				model: "faux/echo",
				soul: "You are Navigator, explorer of records.",
				memory: "- Secret codeword: pineapple\n- Stack: Cloudflare Workers",
				toolsEnv: { enabled: false },
				skills: [
					{
						slug: "deploy-guide",
						description: "Deploying Cadmus to Cloudflare",
						category: "ops",
						body: "Run bun run deploy to publish.\nCheck wrangler.jsonc first.",
					},
					{
						slug: "sqlite-tips",
						description: "DO SQLite query tips",
						category: "db",
						body: "Prefer indexed lookups over full scans.",
					},
				],
			},
			scope,
		);

		await sendRpc(
			"bot.create",
			{
				slug: "other",
				name: "Other",
				model: "faux/echo",
				memory: "- Secret codeword: watermelon",
				toolsEnv: { enabled: false },
			},
			scope,
		);

		// 1. ls with omitted path defaults to /.cadmus when no workspace env is enabled
		const lsRoot = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:navigator",
				text: "[tool:ls {}]",
			},
			scope,
		);
		expect(lsRoot.status).toBe(200);
		expect(lsRoot.frame.result?.reply).toContain("MEMORY.md");
		expect(lsRoot.frame.result?.reply).toContain("SOUL.md");
		expect(lsRoot.frame.result?.reply).toContain("skills/");

		// 2. ls /.cadmus/skills with depth and details
		const lsSkills = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:navigator",
				text: '[tool:ls {"path":"/.cadmus/skills","depth":3,"details":true}]',
			},
			scope,
		);
		expect(lsSkills.frame.result?.reply).toContain("bot/ [dir]");
		expect(lsSkills.frame.result?.reply).toContain("family/ [dir]");
		expect(lsSkills.frame.result?.reply).toContain("bot/deploy-guide/ [dir]");
		expect(lsSkills.frame.result?.reply).toContain(
			"bot/deploy-guide/SKILL.md [file,",
		);
		expect(lsSkills.frame.result?.reply).toContain(
			"Deploying Cadmus to Cloudflare",
		);
		expect(lsSkills.frame.result?.reply).toContain("bot/sqlite-tips/SKILL.md");

		// 3. find with glob pattern
		const findSkills = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:navigator",
				text: '[tool:find {"pattern":"/.cadmus/skills/**/*.md"}]',
			},
			scope,
		);
		expect(findSkills.frame.result?.reply).toContain(
			"/.cadmus/skills/bot/deploy-guide/SKILL.md",
		);
		expect(findSkills.frame.result?.reply).toContain(
			"/.cadmus/skills/bot/sqlite-tips/SKILL.md",
		);
		expect(findSkills.frame.result?.reply).not.toContain("/.cadmus/MEMORY.md");

		// 4. grep across VFS with ignoreCase and path scope
		const grepAll = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:navigator",
				text: '[tool:grep {"pattern":"CLOUDFLARE","ignoreCase":true}]',
			},
			scope,
		);
		expect(grepAll.frame.result?.reply).toContain(
			"/.cadmus/MEMORY.md:2: - Stack: Cloudflare Workers",
		);
		expect(grepAll.frame.result?.reply).toContain(
			"/.cadmus/skills/bot/deploy-guide/SKILL.md:3: description: Deploying Cadmus to Cloudflare",
		);
		// Must not leak other bot's memory
		expect(grepAll.frame.result?.reply).not.toContain("watermelon");

		// 5. grep on other bot must not see navigator's files
		const grepOther = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:other",
				text: '[tool:grep {"pattern":"pineapple"}]',
			},
			scope,
		);
		expect(grepOther.frame.result?.reply).toContain("No matches found.");

		// 6. Invalid regex returns a clean tool error
		const badRegex = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:navigator",
				text: '[tool:grep {"pattern":"[unclosed"}]',
			},
			scope,
		);
		expect(badRegex.frame.result?.reply).toContain("Invalid regex pattern");

		// 7. Non-virtual path when workspace env is off returns disabled error
		const noWorkspace = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:navigator",
				text: '[tool:ls {"path":"/workspace"}]',
			},
			scope,
		);
		expect(noWorkspace.frame.result?.reply).toContain(
			"No workspace tools environment is enabled",
		);

		// 8. Additional VFS edge cases: single-file ls, missing ls path, glob with ?, {a,b}, [abc], literal grep, limit, and glob filter
		const lsSingle = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:navigator",
				text: '[tool:ls {"path":"/.cadmus/MEMORY.md","details":true}]',
			},
			scope,
		);
		expect(lsSingle.frame.result?.reply).toContain("/.cadmus/MEMORY.md [file,");

		const lsMissing = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:navigator",
				text: '[tool:ls {"path":"/.cadmus/does-not-exist"}]',
			},
			scope,
		);
		expect(lsMissing.frame.result?.reply).toContain("not found");

		const findBrace = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:navigator",
				text: '[tool:find {"pattern":"**/{MEMORY,SOUL}.md","path":"/.cadmus"}]',
			},
			scope,
		);
		expect(findBrace.frame.result?.reply).toContain("/.cadmus/MEMORY.md");
		expect(findBrace.frame.result?.reply).toContain("/.cadmus/SOUL.md");

		const findSingle = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:navigator",
				text: '[tool:find {"pattern":"/.cadmus/skills/bot/sqlite-tip?/SKILL.md"}]',
			},
			scope,
		);
		expect(findSingle.frame.result?.reply).toContain(
			"/.cadmus/skills/bot/sqlite-tips/SKILL.md",
		);

		const grepFiltered = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:navigator",
				text: '[tool:grep {"pattern":"wrangler","path":"/.cadmus/skills","glob":"**/*deploy*/**","literal":true,"limit":1}]',
			},
			scope,
		);
		expect(grepFiltered.frame.result?.reply).toContain(
			"/.cadmus/skills/bot/deploy-guide/SKILL.md:8: Check wrangler.jsonc first.",
		);

		const grepBasenameGlob = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:navigator",
				text: '[tool:grep {"pattern":"indexed lookups","path":"/.cadmus/skills","glob":"*.md"}]',
			},
			scope,
		);
		expect(grepBasenameGlob.frame.result?.reply).toContain(
			"/.cadmus/skills/bot/sqlite-tips/SKILL.md:7: Prefer indexed lookups over full scans.",
		);

		const noWsFind = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:navigator",
				text: '[tool:find {"pattern":"*.ts","path":"/workspace"}]',
			},
			scope,
		);
		expect(noWsFind.frame.result?.reply).toContain(
			"No workspace tools environment is enabled",
		);

		const noWsGrep = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:navigator",
				text: '[tool:grep {"pattern":"hello","path":"/workspace"}]',
			},
			scope,
		);
		expect(noWsGrep.frame.result?.reply).toContain(
			"No workspace tools environment is enabled",
		);
	});

	it("forwards workspace paths to just-bash while keeping /.cadmus/* on DO SQLite", async () => {
		const scope = await adminScope("default");

		await sendRpc(
			"bot.create",
			{
				slug: "coder",
				name: "Coder",
				model: "faux/echo",
				memory: "- Virtual memory marker: vfs-only-token",
				toolsEnv: { enabled: true, binding: { envId: "jb_default" } },
			},
			scope,
		);

		const wrote = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:coder",
				text: '[tool:write {"path":"/workspace/src/hello.ts","content":"export const greeting = \\"hello world\\";\\n"}]',
			},
			scope,
		);
		expect(wrote.status).toBe(200);
		expect(wrote.frame.result?.reply).toContain("Successfully wrote");

		const wsFind = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:coder",
				text: '[tool:find {"pattern":"**/*.ts"}]',
			},
			scope,
		);
		expect(wsFind.frame.result?.reply).toContain("/workspace/src/hello.ts");

		const wsGrep = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:coder",
				text: '[tool:grep {"pattern":"hello world"}]',
			},
			scope,
		);
		expect(wsGrep.frame.result?.reply).toContain(
			'/workspace/src/hello.ts:1: export const greeting = "hello world";',
		);

		const vfsGrep = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:coder",
				text: '[tool:grep {"pattern":"vfs-only-token","path":"/.cadmus"}]',
			},
			scope,
		);
		expect(vfsGrep.frame.result?.reply).toContain(
			"/.cadmus/MEMORY.md:1: - Virtual memory marker: vfs-only-token",
		);

		const vfsLs = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:coder",
				text: '[tool:ls {"path":"/.cadmus"}]',
			},
			scope,
		);
		expect(vfsLs.frame.result?.reply).toContain("MEMORY.md");
		expect(vfsLs.frame.result?.reply).toContain("SOUL.md");
		expect(vfsLs.frame.result?.reply).toContain("skills/");

		const wsLs = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:coder",
				text: '[tool:ls {"depth":2,"details":true}]',
			},
			scope,
		);
		expect(wsLs.frame.result?.reply).toContain("src/ [dir]");
		expect(wsLs.frame.result?.reply).toContain("src/hello.ts [file,");

		const wsLsFile = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:coder",
				text: '[tool:ls {"path":"/workspace/src/hello.ts","details":true}]',
			},
			scope,
		);
		expect(wsLsFile.frame.result?.reply).toContain(
			"/workspace/src/hello.ts [file,",
		);

		const wsGrepSingle = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:coder",
				text: '[tool:grep {"pattern":"GREETING","path":"/workspace/src/hello.ts","ignoreCase":true,"literal":true,"limit":1}]',
			},
			scope,
		);
		expect(wsGrepSingle.frame.result?.reply).toContain(
			"/workspace/src/hello.ts:1:",
		);
	});

	it("shares /.cadmus/skills/family/* across bots while isolating /.cadmus/skills/bot/* and preserving family skills on bot.delete", async () => {
		const scope = await adminScope("default");

		await sendRpc(
			"bot.create",
			{
				slug: "alpha",
				name: "Alpha",
				model: "faux/echo",
				toolsEnv: { enabled: false },
			},
			scope,
		);
		await sendRpc(
			"bot.create",
			{
				slug: "beta",
				name: "Beta",
				model: "faux/echo",
				toolsEnv: { enabled: false },
			},
			scope,
		);

		// Alpha writes a bot-scoped skill and a family-scoped skill (with the same slug to verify no collision)
		const writeBot = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:alpha",
				text: `[tool:write ${JSON.stringify({
					path: "/.cadmus/skills/bot/runbook/SKILL.md",
					content:
						"---\nname: runbook\ndescription: Alpha personal runbook\n---\n\nAlpha private step.",
				})}]`,
			},
			scope,
		);
		expect(writeBot.frame.result?.reply).toContain(
			"Successfully wrote to /.cadmus/skills/bot/runbook/SKILL.md",
		);

		const writeFamily = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:alpha",
				text: `[tool:write ${JSON.stringify({
					path: "/.cadmus/skills/family/runbook/SKILL.md",
					content:
						"---\nname: runbook\ndescription: Shared team runbook\ncategory: ops\n---\n\nShared escalation step.",
				})}]`,
			},
			scope,
		);
		expect(writeFamily.frame.result?.reply).toContain(
			"Successfully wrote to /.cadmus/skills/family/runbook/SKILL.md",
		);

		// Alpha sees both bot and family skills in a single find/grep against /.cadmus/skills
		const alphaFind = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:alpha",
				text: '[tool:find {"pattern":"/.cadmus/skills/**/*.md"}]',
			},
			scope,
		);
		expect(alphaFind.frame.result?.reply).toContain(
			"/.cadmus/skills/bot/runbook/SKILL.md",
		);
		expect(alphaFind.frame.result?.reply).toContain(
			"/.cadmus/skills/family/runbook/SKILL.md",
		);

		const alphaGrep = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:alpha",
				text: '[tool:grep {"pattern":"step","path":"/.cadmus/skills"}]',
			},
			scope,
		);
		expect(alphaGrep.frame.result?.reply).toContain(
			"/.cadmus/skills/bot/runbook/SKILL.md",
		);
		expect(alphaGrep.frame.result?.reply).toContain(
			"/.cadmus/skills/family/runbook/SKILL.md",
		);

		// Beta sees the shared family skill but NOT Alpha's bot skill
		const betaFind = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:beta",
				text: '[tool:find {"pattern":"/.cadmus/skills/**/*.md"}]',
			},
			scope,
		);
		expect(betaFind.frame.result?.reply).toContain(
			"/.cadmus/skills/family/runbook/SKILL.md",
		);
		expect(betaFind.frame.result?.reply).not.toContain(
			"/.cadmus/skills/bot/runbook/SKILL.md",
		);

		// Beta can edit and read the shared family skill
		const betaEdit = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:beta",
				text: `[tool:edit ${JSON.stringify({
					path: "/.cadmus/skills/family/runbook/SKILL.md",
					edits: [
						{
							oldText: "Shared escalation step.",
							newText: "Shared escalation step (updated by Beta).",
						},
					],
				})}]`,
			},
			scope,
		);
		expect(betaEdit.frame.result?.reply).toContain("Successfully replaced");

		// Deleting Alpha preserves the shared family skill
		await sendRpc("bot.delete", { botId: "alpha" }, scope);

		const betaReadAfterDelete = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:beta",
				text: '[tool:read {"path":"/.cadmus/skills/family/runbook/SKILL.md"}]',
			},
			scope,
		);
		expect(betaReadAfterDelete.frame.result?.reply).toContain(
			"Shared escalation step (updated by Beta).",
		);

		// Beta can delete the family skill
		const betaDelete = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:beta",
				text: '[tool:delete {"path":"/.cadmus/skills/family/runbook/SKILL.md"}]',
			},
			scope,
		);
		expect(betaDelete.frame.result?.reply).toContain(
			"Successfully deleted /.cadmus/skills/family/runbook/SKILL.md",
		);
	});
});
