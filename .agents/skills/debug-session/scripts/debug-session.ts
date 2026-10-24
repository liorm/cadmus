#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

interface BotRow {
	id: string;
	name: string;
	model: string;
	thinking: string;
	tools_json?: string | null;
	root_conversation_id?: number;
	rootConversationId?: number;
	created_at?: number;
	createdAt?: number;
}

interface ChatRow {
	key: string;
	bot_id?: string;
	botId?: string;
	conversation_id?: number;
	conversationId?: number;
	title: string | null;
	closed: number | boolean;
	created_at?: number;
	createdAt?: number;
}

interface MemoryRow {
	bot_id?: string;
	botId?: string;
	content: string;
	version: number;
	updated_at?: number;
	updatedAt?: number;
}

interface KnowledgeRow {
	bot_id?: string;
	botId?: string;
	slug: string;
	description: string;
	category: string | null;
	version: number;
	body?: string;
	content?: string;
	updated_at?: number;
	updatedAt?: number;
}

interface SoulRow {
	bot_id?: string;
	botId?: string;
	content: string;
	updated_at?: number;
	updatedAt?: number;
}

interface EntryRow {
	id: number;
	conversation_id: number;
	commit_seq: number;
	record: string;
}

const PRODUCTION_DEFAULT_URL = "https://cadmus.purelogicstudios.com";
const PREVIEW_HOST_SUFFIX = "cadmus.pure-logic-studios.workers.dev";

function normalizePreviewUrl(input: string): string {
	const trimmed = input.trim();
	if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
		return trimmed;
	}
	if (trimmed.includes(".workers.dev")) {
		return `https://${trimmed}`;
	}
	const slug = trimmed.replace(/[/_]/g, "-").replace(/[^a-zA-Z0-9-]/g, "");
	return `https://${slug}-${PREVIEW_HOST_SUFFIX}`;
}

function findDatabasePath(explicitPath?: string): string | null {
	if (explicitPath) {
		if (!existsSync(explicitPath)) {
			console.error(`Error: SQLite database not found at '${explicitPath}'`);
			process.exit(1);
		}
		return resolve(explicitPath);
	}

	const defaultDir = "./.wrangler/state/v3/do/cadmus-CadmusBotFamilyDO";
	if (existsSync(defaultDir)) {
		const files = readdirSync(defaultDir).filter(
			(f) => f.endsWith(".sqlite") && f !== "metadata.sqlite",
		);
		if (files.length > 0) {
			return resolve(join(defaultDir, files[0]));
		}
	}

	return null;
}

interface CliOptions {
	target?: string;
	action?:
		| "summary"
		| "memory"
		| "knowledge"
		| "soul"
		| "conversation"
		| "chats"
		| "list";
	knowledgeSlug?: string;
	dbPath?: string;
	searchQuery?: string;
	json?: boolean;
	remoteUrl?: string;
	token?: string;
	accountId?: string;
	familyId?: string;
	cfClientId?: string;
	cfClientSecret?: string;
	cookie?: string;
	help?: boolean;
}

function parseCliArgs(): CliOptions {
	const args = process.argv.slice(2);
	const options: CliOptions = {};
	const positional: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help" || arg === "-h") {
			options.help = true;
		} else if (arg === "--db") {
			options.dbPath = args[++i];
		} else if (arg === "--url") {
			options.remoteUrl = args[++i];
		} else if (
			arg === "--prod" ||
			arg === "--production" ||
			arg === "--cloud"
		) {
			options.remoteUrl = PRODUCTION_DEFAULT_URL;
		} else if (arg === "--preview" || arg === "-p") {
			const branch = args[++i] ?? "";
			options.remoteUrl = normalizePreviewUrl(branch);
		} else if (arg === "--local") {
			options.remoteUrl = undefined;
		} else if (arg === "--token") {
			options.token = args[++i];
		} else if (arg === "--account" || arg === "--account-id") {
			options.accountId = args[++i];
		} else if (arg === "--family" || arg === "--family-id") {
			options.familyId = args[++i];
		} else if (arg === "--cf-client-id") {
			options.cfClientId = args[++i];
		} else if (arg === "--cf-client-secret") {
			options.cfClientSecret = args[++i];
		} else if (arg === "--cookie") {
			options.cookie = args[++i];
		} else if (arg === "--bot" || arg === "--chat") {
			options.target = args[++i];
		} else if (arg === "--memory") {
			options.action = "memory";
		} else if (arg === "--knowledge") {
			options.action = "knowledge";
			if (args[i + 1] && !args[i + 1].startsWith("-")) {
				options.knowledgeSlug = args[++i];
			}
		} else if (arg === "--soul") {
			options.action = "soul";
		} else if (arg === "--conversation" || arg === "--chat-log") {
			options.action = "conversation";
		} else if (arg === "--chats") {
			options.action = "chats";
		} else if (arg === "--list") {
			options.action = "list";
		} else if (arg === "--search" || arg === "--filter" || arg === "--ask") {
			options.searchQuery = args[++i];
		} else if (arg === "--json") {
			options.json = true;
		} else if (!arg.startsWith("-")) {
			positional.push(arg);
		}
	}

	if (!options.target && positional.length > 0) {
		options.target = positional[0];
	}

	if (!options.action && positional.length > 1) {
		const act = positional[1].toLowerCase();
		if (
			[
				"summary",
				"memory",
				"knowledge",
				"soul",
				"conversation",
				"chats",
				"list",
			].includes(act)
		) {
			options.action = act as NonNullable<typeof options.action>;
			if (act === "knowledge" && positional[2]) {
				options.knowledgeSlug = positional[2];
			}
		} else if (!options.searchQuery) {
			options.searchQuery = positional.slice(1).join(" ");
		}
	}

	if (!options.action) {
		if (options.searchQuery) {
			options.action = "conversation";
		} else if (options.target === "list") {
			options.action = "list";
			options.target = undefined;
		} else {
			options.action = "summary";
		}
	}

	// Environment variable defaults
	if (!options.remoteUrl && !options.dbPath && process.env.CADMUS_URL) {
		options.remoteUrl = process.env.CADMUS_URL;
	}
	options.token ??= process.env.CADMUS_TOKEN ?? "dev-cadmus-secret";
	options.accountId ??= process.env.CADMUS_ACCOUNT_ID ?? "default-account";
	options.familyId ??= process.env.CADMUS_FAMILY_ID ?? "default";
	options.cfClientId ??= process.env.CF_ACCESS_CLIENT_ID;
	options.cfClientSecret ??= process.env.CF_ACCESS_CLIENT_SECRET;
	if (!options.cookie && process.env.CF_AUTHORIZATION) {
		options.cookie = `CF_Authorization=${process.env.CF_AUTHORIZATION}`;
	}

	return options;
}

function printHelp() {
	console.log(`
Cadmus Debug Session Helper (Local & Cloud)

USAGE:
  bun .agents/skills/debug-session/scripts/debug-session.ts [target] [action] [options]

TARGETS:
  list                  List all bots and chats
  <botId>               Inspect a specific bot (e.g. 'assistant', 'x')
  <chatKey>             Inspect a specific chat (e.g. 'assistant:43e02030')

ACTIONS:
  summary               General overview (default)
  memory                Print or dump MEMORY.md
  knowledge [slug]      List knowledge files or print a specific slug
  soul                  Print or dump SOUL.md
  chats                 List all chats for a bot
  conversation          View formatted conversation transcript

OPTIONS:
  --prod, --production  Target cloud production (${PRODUCTION_DEFAULT_URL})
  --preview, -p <branch> Target cloud branch preview (*-${PREVIEW_HOST_SUFFIX})
  --url <url>           Target explicit Cadmus HTTP/RPC URL
  --local               Force local SQLite DO mode
  --db <path>           Explicit path to local DO SQLite database
  --token <token>       Bearer token (default: CADMUS_TOKEN or 'dev-cadmus-secret')
  --account <id>        Account ID header (default: CADMUS_ACCOUNT_ID or 'default-account')
  --family <id>         Family ID header (default: CADMUS_FAMILY_ID or 'default')
  --cf-client-id <id>   Cloudflare Access Service Token Client ID
  --cf-client-secret <s Cloudflare Access Service Token Client Secret
  --cookie <str>        Cookie header (e.g. 'CF_Authorization=...')
  --search, --filter    Filter transcript turns by substring
  --json                Output results as JSON
  -h, --help            Show this help screen

EXAMPLES:
  # Local SQLite:
  bun .agents/skills/debug-session/scripts/debug-session.ts list
  bun .agents/skills/debug-session/scripts/debug-session.ts assistant conversation

  # Cloud Production:
  bun .agents/skills/debug-session/scripts/debug-session.ts list --prod
  bun .agents/skills/debug-session/scripts/debug-session.ts assistant memory --prod

  # Cloud Preview:
  bun .agents/skills/debug-session/scripts/debug-session.ts list --preview my-feature
  bun .agents/skills/debug-session/scripts/debug-session.ts assistant:1234 conversation -p my-feature

  # Cloudflare Worker name for Wrangler commands:
  wrangler tail cadmus
`);
}

async function sendRpc<T>(
	baseUrl: string,
	type: string,
	payload: unknown,
	cli: CliOptions,
): Promise<T> {
	const url = new URL("/rpc", baseUrl);
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${cli.token}`,
		"x-account-id": cli.accountId ?? "default-account",
		"X-Cadmus-Family-Id": cli.familyId ?? "default",
	};

	if (cli.cfClientId && cli.cfClientSecret) {
		headers["CF-Access-Client-Id"] = cli.cfClientId;
		headers["CF-Access-Client-Secret"] = cli.cfClientSecret;
	}
	if (cli.cookie) {
		headers.Cookie = cli.cookie;
	}

	let res: Response;
	try {
		res = await fetch(url.toString(), {
			method: "POST",
			headers,
			body: JSON.stringify({
				id: `debug-${crypto.randomUUID().slice(0, 8)}`,
				type,
				...(payload !== undefined ? { payload } : {}),
			}),
		});
	} catch (err) {
		throw new Error(
			`Network error connecting to Cadmus at ${url.toString()}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	const contentType = res.headers.get("content-type") ?? "";
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`[HTTP ${res.status} ${res.statusText}] ${text}`);
	}

	if (!contentType.includes("application/json")) {
		const text = await res.text();
		if (
			res.status === 302 ||
			text.includes("cloudflareaccess.com") ||
			text.includes("Cloudflare Access")
		) {
			throw new Error(
				`Remote endpoint at ${baseUrl} is protected by Cloudflare Access.\n` +
					"Please provide Cloudflare Access Service Token credentials:\n" +
					"  --cf-client-id <id> --cf-client-secret <secret>\n" +
					"  (or set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET)\n" +
					"Or provide an active session cookie:\n" +
					'  --cookie "CF_Authorization=..." (or set CF_AUTHORIZATION)',
			);
		}
		throw new Error(
			`[HTTP ${res.status}] Expected JSON from ${baseUrl}/rpc, but got:\n${text.slice(0, 300)}`,
		);
	}

	const data = (await res.json()) as {
		type?: string;
		ok?: boolean;
		payload?: { message?: string };
		error?: { message?: string };
		result?: T;
	};

	if (data.type === "protocol.error") {
		throw new Error(
			data.payload?.message ??
				`Protocol error: ${JSON.stringify(data.payload)}`,
		);
	}
	if (data.ok === false) {
		throw new Error(
			data.error?.message ?? `Command failed: ${JSON.stringify(data.error)}`,
		);
	}

	return data.result as T;
}

async function runRemote(baseUrl: string, cli: CliOptions) {
	if (cli.action === "list" || (!cli.target && cli.action === "summary")) {
		const botsRes = await sendRpc<{ bots: BotRow[] }>(
			baseUrl,
			"bot.list",
			{},
			cli,
		);
		const chatsRes = await sendRpc<{ chats: ChatRow[] }>(
			baseUrl,
			"chat.list",
			{},
			cli,
		);
		const bots = botsRes.bots ?? [];
		const chats = chatsRes.chats ?? [];

		if (cli.json) {
			console.log(JSON.stringify({ bots, chats, remoteUrl: baseUrl }, null, 2));
			return;
		}

		console.log(`\n=== BOTS IN CLOUD (${baseUrl}) (${bots.length}) ===`);
		for (const b of bots) {
			const rootConv = b.rootConversationId ?? b.root_conversation_id ?? 0;
			console.log(
				`• ${b.id.padEnd(12)} name: ${b.name.padEnd(16)} model: ${b.model.padEnd(16)} rootConv: ${rootConv}`,
			);
		}

		console.log(`\n=== CHATS (${chats.length}) ===`);
		for (const c of chats) {
			const convId = c.conversationId ?? c.conversation_id ?? 0;
			const botId = c.botId ?? c.bot_id ?? "";
			const createdAt = c.createdAt ?? c.created_at ?? 0;
			const dateStr = createdAt ? new Date(createdAt).toISOString() : "unknown";
			console.log(
				`• ${c.key.padEnd(18)} bot: ${botId.padEnd(10)} convId: ${String(convId).padEnd(5)} created: ${dateStr}`,
			);
		}
		console.log(
			`\nRun with: debug-session <botId|chatKey> [action] --url ${baseUrl}\n`,
		);
		return;
	}

	const target = cli.target;
	if (!target) {
		console.error(
			"Please specify a botId or chatKey (e.g. 'assistant' or 'assistant:43e02030').",
		);
		process.exit(1);
	}

	// Resolve whether target is a chatKey or botId
	const { chats } = await sendRpc<{ chats: ChatRow[] }>(
		baseUrl,
		"chat.list",
		{},
		cli,
	);
	const matchedChat = (chats ?? []).find(
		(c) =>
			c.key === target ||
			c.key.includes(target) ||
			String(c.conversationId ?? c.conversation_id) === target,
	);

	let botId: string;
	let selectedChatKey: string | null = null;

	if (matchedChat) {
		selectedChatKey = matchedChat.key;
		botId = matchedChat.botId ?? matchedChat.bot_id ?? "";
	} else {
		botId = target;
	}

	switch (cli.action) {
		case "memory": {
			const mem = await sendRpc<MemoryRow>(
				baseUrl,
				"file.read",
				{ botId, path: "MEMORY.md" },
				cli,
			).catch(() => null);

			if (cli.json) {
				console.log(
					JSON.stringify(
						mem ?? {
							botId,
							content: "",
							version: 0,
							exists: false,
						},
						null,
						2,
					),
				);
				return;
			}

			console.log(`\n=== MEMORY.md for bot '${botId}' [CLOUD: ${baseUrl}] ===`);
			if (!mem || mem.version === 0 || !mem.content) {
				console.log("(Memory is currently empty / version 0)");
			} else {
				console.log(`Version:    ${mem.version}`);
				console.log("------------------------------------------");
				console.log(mem.content);
				console.log("------------------------------------------");
			}
			break;
		}

		case "knowledge": {
			if (cli.knowledgeSlug) {
				const doc = await sendRpc<KnowledgeRow>(
					baseUrl,
					"file.read",
					{ botId, path: `knowledge/${cli.knowledgeSlug}.md` },
					cli,
				).catch(() => null);

				if (cli.json) {
					console.log(JSON.stringify(doc ?? null, null, 2));
					return;
				}

				if (!doc) {
					console.log(
						`Knowledge entry '${cli.knowledgeSlug}' not found for bot '${botId}'.`,
					);
				} else {
					console.log(`\n=== knowledge/${doc.slug}.md [CLOUD: ${baseUrl}] ===`);
					console.log(`Description: ${doc.description}`);
					if (doc.category) console.log(`Category:    ${doc.category}`);
					console.log(`Version:     ${doc.version}`);
					console.log("------------------------------------------");
					console.log(doc.body ?? doc.content ?? "");
					console.log("------------------------------------------");
				}
			} else {
				const filesRes = await sendRpc<{
					files: Array<{
						path: string;
						kind: string;
						slug?: string;
						description?: string;
						category?: string | null;
						version?: number;
						size?: number;
					}>;
				}>(baseUrl, "file.list", { botId }, cli).catch(() => ({ files: [] }));

				const docs = (filesRes.files ?? []).filter(
					(f) => f.kind === "knowledge" || f.path.startsWith("knowledge/"),
				);

				if (cli.json) {
					console.log(JSON.stringify(docs, null, 2));
					return;
				}

				console.log(
					`\n=== KNOWLEDGE FILES for bot '${botId}' [CLOUD: ${baseUrl}] (${docs.length}) ===`,
				);
				if (docs.length === 0) {
					console.log("(No knowledge files found)");
				} else {
					for (const d of docs) {
						const slug = d.slug ?? d.path.replace(/^knowledge\/|\.md$/g, "");
						console.log(
							`• ${slug.padEnd(24)} v${d.version ?? 1}  category: ${(d.category ?? "none").padEnd(12)} desc: ${d.description ?? ""}`,
						);
					}
				}
			}
			break;
		}

		case "soul": {
			const soul = await sendRpc<SoulRow>(
				baseUrl,
				"file.read",
				{ botId, path: "SOUL.md" },
				cli,
			).catch(() => null);

			if (cli.json) {
				console.log(JSON.stringify(soul ?? null, null, 2));
				return;
			}

			console.log(`\n=== SOUL.md for bot '${botId}' [CLOUD: ${baseUrl}] ===`);
			if (!soul?.content) {
				console.log("(No custom SOUL.md found)");
			} else {
				console.log("------------------------------------------");
				console.log(soul.content);
				console.log("------------------------------------------");
			}
			break;
		}

		case "chats": {
			const { chats: botChats } = await sendRpc<{ chats: ChatRow[] }>(
				baseUrl,
				"chat.list",
				{ botId },
				cli,
			);

			if (cli.json) {
				console.log(JSON.stringify(botChats ?? [], null, 2));
				return;
			}

			console.log(
				`\n=== CHATS for bot '${botId}' [CLOUD: ${baseUrl}] (${(botChats ?? []).length}) ===`,
			);
			for (const c of botChats ?? []) {
				const convId = c.conversationId ?? c.conversation_id ?? 0;
				const createdAt = c.createdAt ?? c.created_at ?? 0;
				console.log(
					`• ${c.key.padEnd(20)} convId: ${String(convId).padEnd(5)} created: ${createdAt ? new Date(createdAt).toISOString() : "unknown"} title: ${c.title ?? "(none)"}`,
				);
			}
			break;
		}

		case "conversation": {
			let chatKey = selectedChatKey;
			if (!chatKey) {
				const { chats: botChats } = await sendRpc<{ chats: ChatRow[] }>(
					baseUrl,
					"chat.list",
					{ botId },
					cli,
				);
				if (botChats && botChats.length > 0) {
					chatKey = botChats[0].key;
				}
			}

			if (!chatKey) {
				console.error(`No chat found for target '${target}' on ${baseUrl}.`);
				process.exit(1);
			}

			const transcript = await sendRpc<{
				chat?: ChatRow;
				messages?: Array<{
					id: number;
					role: string;
					text?: string;
					blocks?: Array<{
						type: string;
						text?: string;
						thinking?: string;
						name?: string;
						arguments?: unknown;
						result?: { content?: string; isError?: boolean };
					}>;
				}>;
				entries?: unknown[];
			}>(baseUrl, "chat.entries", { chatKey }, cli);

			if (cli.json) {
				console.log(
					JSON.stringify(
						transcript.entries ?? transcript.messages ?? [],
						null,
						2,
					),
				);
				return;
			}

			console.log(
				`\n=== CONVERSATION TRANSCRIPT: ${chatKey} [CLOUD: ${baseUrl}] ===\n`,
			);

			let turnCount = 0;
			const query = cli.searchQuery?.toLowerCase();

			for (const msg of transcript.messages ?? []) {
				let rendered = "";

				if (msg.role === "user") {
					rendered = `\x1b[32m[USER]\x1b[0m ${msg.text ?? ""}`;
				} else if (msg.role === "assistant") {
					const parts: string[] = [];
					for (const b of msg.blocks ?? []) {
						if (b.type === "text" && b.text) {
							parts.push(`\x1b[36m[ASSISTANT]\x1b[0m ${b.text}`);
						} else if (b.type === "thinking" && b.thinking) {
							parts.push(`\x1b[90m[THINKING]\x1b[0m ${b.thinking}`);
						} else if (b.type === "toolCall") {
							parts.push(
								`\x1b[33m[TOOL CALL]\x1b[0m ${b.name}(${JSON.stringify(b.arguments)})`,
							);
							if (b.result) {
								const errPrefix = b.result.isError
									? "\x1b[31m[ERROR]\x1b[0m "
									: "";
								parts.push(
									`\x1b[35m[TOOL RESULT]\x1b[0m ${b.name} -> ${errPrefix}${b.result.content ?? ""}`,
								);
							}
						}
					}
					if (parts.length === 0 && msg.text) {
						parts.push(`\x1b[36m[ASSISTANT]\x1b[0m ${msg.text}`);
					}
					rendered = parts.join("\n");
				}

				if (rendered) {
					if (query && !rendered.toLowerCase().includes(query)) {
						continue;
					}
					turnCount++;
					console.log(`[#${msg.id ?? turnCount}] ${rendered}\n`);
				}
			}

			if (query && turnCount === 0) {
				console.log(`(No entries matched search filter: '${cli.searchQuery}')`);
			}
			break;
		}

		default: {
			const botRes = await sendRpc<{ bot?: BotRow }>(
				baseUrl,
				"bot.get",
				{ botId },
				cli,
			).catch(() => ({ bot: undefined }));
			const bot = botRes.bot;
			const mem = await sendRpc<MemoryRow>(
				baseUrl,
				"file.read",
				{ botId, path: "MEMORY.md" },
				cli,
			).catch(() => null);
			const filesRes = await sendRpc<{
				files: Array<{
					path: string;
					kind: string;
					slug?: string;
					version?: number;
				}>;
			}>(baseUrl, "file.list", { botId }, cli).catch(() => ({ files: [] }));
			const knowledgeFiles = (filesRes.files ?? []).filter(
				(f) => f.kind === "knowledge" || f.path?.startsWith("knowledge/"),
			);
			const { chats: botChats } = await sendRpc<{ chats: ChatRow[] }>(
				baseUrl,
				"chat.list",
				{ botId },
				cli,
			).catch(() => ({ chats: [] }));

			if (cli.json) {
				console.log(
					JSON.stringify(
						{
							bot,
							activeOrSelectedChat: matchedChat,
							memory: mem,
							knowledgeFilesCount: knowledgeFiles.length,
							chats: botChats,
							remoteUrl: baseUrl,
						},
						null,
						2,
					),
				);
				return;
			}

			console.log(`\n==========================================`);
			console.log(
				` BOT: ${bot ? `${bot.name} (${bot.id})` : botId} [CLOUD: ${baseUrl}]`,
			);
			if (bot) {
				console.log(` Model:    ${bot.model}`);
				console.log(` Thinking: ${bot.thinking}`);
			}
			console.log(`==========================================`);

			console.log(`\n📄 MEMORY.md:`);
			if (!mem || mem.version === 0 || !mem.content) {
				console.log(`   (empty / version 0)`);
			} else {
				console.log(`   Version: ${mem.version}`);
				const preview = mem.content
					.split("\n")
					.map((l: string) => `   > ${l}`)
					.join("\n");
				console.log(preview);
			}

			console.log(`\n📚 KNOWLEDGE: ${knowledgeFiles.length} file(s)`);
			if (knowledgeFiles.length > 0) {
				for (const s of knowledgeFiles.slice(0, 5)) {
					const slug = s.slug ?? s.path.replace(/^knowledge\/|\.md$/g, "");
					console.log(`   • knowledge/${slug}.md (v${s.version ?? 1})`);
				}
			}

			console.log(`\n💬 CHATS: ${(botChats ?? []).length} chat(s)`);
			for (const c of botChats ?? []) {
				const convId = c.conversationId ?? c.conversation_id ?? 0;
				const createdAt = c.createdAt ?? c.created_at ?? 0;
				const mark = matchedChat && matchedChat.key === c.key ? "-> " : "   ";
				console.log(
					`${mark}• ${c.key.padEnd(20)} convId: ${String(convId).padEnd(5)} created: ${createdAt ? new Date(createdAt).toISOString() : "unknown"}`,
				);
			}

			console.log(
				`\nTip: Run with 'conversation', 'memory', or 'knowledge' to drill down:`,
			);
			console.log(
				`  bun .agents/skills/debug-session/scripts/debug-session.ts ${target} conversation --url ${baseUrl}`,
			);
			console.log(
				`  bun .agents/skills/debug-session/scripts/debug-session.ts ${target} memory --url ${baseUrl}`,
			);
			console.log(
				`  bun .agents/skills/debug-session/scripts/debug-session.ts ${target} --search "remember" --url ${baseUrl}`,
			);
			console.log();
			break;
		}
	}
}

function runLocal(dbPath: string, cli: CliOptions) {
	const db = new Database(dbPath);

	if (cli.action === "list" || (!cli.target && cli.action === "summary")) {
		const bots = db
			.query<BotRow, []>(
				"SELECT id, name, model, thinking, root_conversation_id, created_at FROM cadmus_bots ORDER BY created_at ASC",
			)
			.all();
		const chats = db
			.query<ChatRow, []>(
				"SELECT key, bot_id, conversation_id, title, closed, created_at FROM cadmus_chats ORDER BY created_at DESC",
			)
			.all();

		if (cli.json) {
			console.log(JSON.stringify({ bots, chats }, null, 2));
			return;
		}

		console.log(`\n=== BOTS IN LOCAL FAMILY (${bots.length}) ===`);
		for (const b of bots) {
			console.log(
				`• ${b.id.padEnd(12)} name: ${b.name.padEnd(16)} model: ${b.model.padEnd(16)} rootConv: ${b.root_conversation_id ?? b.rootConversationId}`,
			);
		}

		console.log(`\n=== CHATS (${chats.length}) ===`);
		for (const c of chats) {
			const convId = c.conversation_id ?? c.conversationId ?? 0;
			const botId = c.bot_id ?? c.botId ?? "";
			const createdAt = c.created_at ?? c.createdAt ?? 0;
			const dateStr = createdAt ? new Date(createdAt).toISOString() : "unknown";
			console.log(
				`• ${c.key.padEnd(18)} bot: ${botId.padEnd(10)} convId: ${String(convId).padEnd(5)} created: ${dateStr}`,
			);
		}
		console.log("\nRun with: debug-session <botId|chatKey> [action]\n");
		return;
	}

	const target = cli.target;
	if (!target) {
		console.error(
			"Please specify a botId or chatKey (e.g. 'assistant' or 'assistant:43e02030').",
		);
		process.exit(1);
	}

	let bot: BotRow | null = null;
	let chat: ChatRow | null = null;

	chat =
		db
			.query<ChatRow, [string]>(
				"SELECT * FROM cadmus_chats WHERE key = ? OR key LIKE ? LIMIT 1",
			)
			.get(target, `%${target}%`) ?? null;

	if (!chat && !Number.isNaN(Number(target))) {
		chat =
			db
				.query<ChatRow, [number]>(
					"SELECT * FROM cadmus_chats WHERE conversation_id = ? LIMIT 1",
				)
				.get(Number(target)) ?? null;
	}

	if (chat) {
		const botId = chat.bot_id ?? chat.botId ?? "";
		bot =
			db
				.query<BotRow, [string]>(
					"SELECT * FROM cadmus_bots WHERE id = ? LIMIT 1",
				)
				.get(botId) ?? null;
	} else {
		bot =
			db
				.query<BotRow, [string]>(
					"SELECT * FROM cadmus_bots WHERE id = ? OR name = ? LIMIT 1",
				)
				.get(target, target) ?? null;
	}

	if (!bot && !chat) {
		console.error(`Error: Neither bot nor chat found matching '${target}'.`);
		process.exit(1);
	}

	const botId = bot ? bot.id : (chat?.bot_id ?? chat?.botId ?? "");
	if (!botId) {
		console.error(`Error: Could not resolve bot ID for '${target}'.`);
		process.exit(1);
	}

	switch (cli.action) {
		case "memory": {
			const mem = db
				.query<MemoryRow, [string]>(
					"SELECT bot_id, content, version, updated_at FROM cadmus_bot_memories WHERE bot_id = ?",
				)
				.get(botId);

			if (cli.json) {
				console.log(
					JSON.stringify(
						mem ?? {
							bot_id: botId,
							content: "",
							version: 0,
							updated_at: 0,
							exists: false,
						},
						null,
						2,
					),
				);
				return;
			}

			console.log(`\n=== MEMORY.md for bot '${botId}' [LOCAL] ===`);
			if (!mem || mem.version === 0 || !mem.content) {
				console.log("(Memory is currently empty / version 0)");
			} else {
				console.log(`Version:    ${mem.version}`);
				console.log(
					`Updated At: ${new Date(mem.updated_at ?? 0).toISOString()}`,
				);
				console.log("------------------------------------------");
				console.log(mem.content);
				console.log("------------------------------------------");
			}
			break;
		}

		case "knowledge": {
			if (cli.knowledgeSlug) {
				const doc = db
					.query<KnowledgeRow, [string, string]>(
						"SELECT * FROM cadmus_bot_knowledge WHERE bot_id = ? AND slug = ?",
					)
					.get(botId, cli.knowledgeSlug);

				if (cli.json) {
					console.log(JSON.stringify(doc ?? null, null, 2));
					return;
				}

				if (!doc) {
					console.log(
						`Knowledge entry '${cli.knowledgeSlug}' not found for bot '${botId}'.`,
					);
				} else {
					console.log(`\n=== knowledge/${doc.slug}.md [LOCAL] ===`);
					console.log(`Description: ${doc.description}`);
					if (doc.category) console.log(`Category:    ${doc.category}`);
					console.log(`Version:     ${doc.version}`);
					console.log(
						`Updated:     ${new Date(doc.updated_at ?? 0).toISOString()}`,
					);
					console.log("------------------------------------------");
					console.log(doc.body ?? doc.content ?? "");
					console.log("------------------------------------------");
				}
			} else {
				const docs = db
					.query<KnowledgeRow, [string]>(
						"SELECT slug, description, category, version, updated_at, length(body) as size FROM cadmus_bot_knowledge WHERE bot_id = ? ORDER BY slug ASC",
					)
					.all(botId);

				if (cli.json) {
					console.log(JSON.stringify(docs, null, 2));
					return;
				}

				console.log(
					`\n=== KNOWLEDGE FILES for bot '${botId}' [LOCAL] (${docs.length}) ===`,
				);
				if (docs.length === 0) {
					console.log("(No knowledge files found)");
				} else {
					for (const d of docs) {
						console.log(
							`• ${d.slug.padEnd(24)} v${d.version}  category: ${(d.category ?? "none").padEnd(12)} desc: ${d.description}`,
						);
					}
				}
			}
			break;
		}

		case "soul": {
			const soul = db
				.query<SoulRow, [string]>(
					"SELECT bot_id, content, updated_at FROM cadmus_bot_souls WHERE bot_id = ?",
				)
				.get(botId);

			if (cli.json) {
				console.log(JSON.stringify(soul ?? null, null, 2));
				return;
			}

			console.log(`\n=== SOUL.md for bot '${botId}' [LOCAL] ===`);
			if (!soul) {
				console.log("(No custom SOUL.md found)");
			} else {
				console.log(
					`Updated At: ${new Date(soul.updated_at ?? 0).toISOString()}`,
				);
				console.log("------------------------------------------");
				console.log(soul.content);
				console.log("------------------------------------------");
			}
			break;
		}

		case "chats": {
			const chats = db
				.query<ChatRow, [string]>(
					"SELECT * FROM cadmus_chats WHERE bot_id = ? ORDER BY created_at DESC",
				)
				.all(botId);

			if (cli.json) {
				console.log(JSON.stringify(chats, null, 2));
				return;
			}

			console.log(
				`\n=== CHATS for bot '${botId}' [LOCAL] (${chats.length}) ===`,
			);
			for (const c of chats) {
				const convId = c.conversation_id ?? c.conversationId ?? 0;
				const createdAt = c.created_at ?? c.createdAt ?? 0;
				console.log(
					`• ${c.key.padEnd(20)} convId: ${String(convId).padEnd(5)} created: ${new Date(createdAt).toISOString()} title: ${c.title ?? "(none)"}`,
				);
			}
			break;
		}

		case "conversation": {
			let convId: number | null =
				chat?.conversation_id ?? chat?.conversationId ?? null;

			if (!convId) {
				const latestChat = db
					.query<ChatRow, [string]>(
						"SELECT * FROM cadmus_chats WHERE bot_id = ? ORDER BY created_at DESC LIMIT 1",
					)
					.get(botId);
				if (latestChat) {
					convId =
						latestChat.conversation_id ?? latestChat.conversationId ?? null;
					chat = latestChat;
				} else {
					convId = bot?.root_conversation_id ?? bot?.rootConversationId ?? null;
				}
			}

			if (!convId) {
				console.error(`No conversation found for target '${target}'.`);
				process.exit(1);
			}

			const entries = db
				.query<EntryRow, [number]>(
					"SELECT id, conversation_id, commit_seq, record FROM cadmus_pi_entries WHERE conversation_id = ? ORDER BY id ASC",
				)
				.all(convId);

			if (cli.json) {
				const parsed = entries.map((e) => ({
					id: e.id,
					commit_seq: e.commit_seq,
					...JSON.parse(e.record),
				}));
				console.log(JSON.stringify(parsed, null, 2));
				return;
			}

			console.log(
				`\n=== CONVERSATION TRANSCRIPT: convId ${convId}${chat ? ` (${chat.key})` : ""} [LOCAL] ===\n`,
			);

			let turnCount = 0;
			const query = cli.searchQuery?.toLowerCase();

			for (const e of entries) {
				const rec = JSON.parse(e.record);
				const modelItems = Array.isArray(rec.model) ? rec.model : [];

				for (const item of modelItems) {
					const role = item.role;
					let rendered = "";

					if (role === "user") {
						rendered = `\x1b[32m[USER]\x1b[0m ${item.content}`;
					} else if (role === "assistant") {
						const parts: string[] = [];
						for (const c of item.content ?? []) {
							if (c.type === "text") {
								parts.push(`\x1b[36m[ASSISTANT]\x1b[0m ${c.text}`);
							} else if (c.type === "thinking") {
								parts.push(`\x1b[90m[THINKING]\x1b[0m ${c.thinking}`);
							} else if (c.type === "toolCall") {
								parts.push(
									`\x1b[33m[TOOL CALL]\x1b[0m ${c.name}(${JSON.stringify(c.arguments)})`,
								);
							}
						}
						rendered = parts.join("\n");
					} else if (role === "toolResult") {
						const resText = item.content?.[0]?.text ?? "";
						const errPrefix = item.isError ? "\x1b[31m[ERROR]\x1b[0m " : "";
						rendered = `\x1b[35m[TOOL RESULT]\x1b[0m ${item.toolName} -> ${errPrefix}${resText}`;
					} else if (role === "system") {
						if (item.sections?.memory) {
							rendered = `\x1b[90m[SYSTEM INJECT: MEMORY]\x1b[0m ${item.sections.memory.replace(/\n/g, " ")}`;
						} else if (item.sections?.knowledge) {
							rendered = `\x1b[90m[SYSTEM INJECT: KNOWLEDGE]\x1b[0m`;
						}
					}

					if (rendered) {
						if (query && !rendered.toLowerCase().includes(query)) {
							continue;
						}
						turnCount++;
						console.log(`[#${e.id}] ${rendered}\n`);
					}
				}
			}

			if (query && turnCount === 0) {
				console.log(`(No entries matched search filter: '${cli.searchQuery}')`);
			}
			break;
		}

		default: {
			const mem = db
				.query<MemoryRow, [string]>(
					"SELECT bot_id, content, version, updated_at FROM cadmus_bot_memories WHERE bot_id = ?",
				)
				.get(botId);
			const knowledgeCount =
				db
					.query<{ count: number }, [string]>(
						"SELECT COUNT(*) as count FROM cadmus_bot_knowledge WHERE bot_id = ?",
					)
					.get(botId)?.count ?? 0;
			const chats = db
				.query<ChatRow, [string]>(
					"SELECT * FROM cadmus_chats WHERE bot_id = ? ORDER BY created_at DESC",
				)
				.all(botId);

			if (cli.json) {
				console.log(
					JSON.stringify(
						{
							bot,
							activeOrSelectedChat: chat,
							memory: mem,
							knowledgeFilesCount: knowledgeCount,
							chats,
						},
						null,
						2,
					),
				);
				return;
			}

			console.log(`\n==========================================`);
			console.log(` BOT: ${bot ? `${bot.name} (${bot.id})` : botId} [LOCAL]`);
			if (bot) {
				console.log(` Model:    ${bot.model}`);
				console.log(` Thinking: ${bot.thinking}`);
			}
			console.log(`==========================================`);

			console.log(`\n📄 MEMORY.md:`);
			if (!mem || mem.version === 0 || !mem.content) {
				console.log(`   (empty / version 0)`);
			} else {
				console.log(
					`   Version: ${mem.version} (Updated: ${new Date(mem.updated_at ?? 0).toISOString()})`,
				);
				const preview = mem.content
					.split("\n")
					.map((l: string) => `   > ${l}`)
					.join("\n");
				console.log(preview);
			}

			console.log(`\n📚 KNOWLEDGE: ${knowledgeCount} file(s)`);
			if (knowledgeCount > 0) {
				const sample = db
					.query<KnowledgeRow, [string]>(
						"SELECT slug, description, version FROM cadmus_bot_knowledge WHERE bot_id = ? LIMIT 5",
					)
					.all(botId);
				for (const s of sample) {
					console.log(`   • knowledge/${s.slug}.md (v${s.version})`);
				}
			}

			console.log(`\n💬 CHATS: ${chats.length} chat(s)`);
			for (const c of chats) {
				const convId = c.conversation_id ?? c.conversationId ?? 0;
				const createdAt = c.created_at ?? c.createdAt ?? 0;
				const mark = chat && chat.key === c.key ? "-> " : "   ";
				console.log(
					`${mark}• ${c.key.padEnd(20)} convId: ${String(convId).padEnd(5)} created: ${new Date(createdAt).toISOString()}`,
				);
			}

			console.log(
				`\nTip: Run with 'conversation', 'memory', or 'knowledge' to drill down:`,
			);
			console.log(
				`  bun .agents/skills/debug-session/scripts/debug-session.ts ${target} conversation`,
			);
			console.log(
				`  bun .agents/skills/debug-session/scripts/debug-session.ts ${target} memory`,
			);
			console.log(
				`  bun .agents/skills/debug-session/scripts/debug-session.ts ${target} --search "remember"`,
			);
			console.log();
			break;
		}
	}
}

async function main() {
	const cli = parseCliArgs();

	if (cli.help) {
		printHelp();
		return;
	}

	if (cli.remoteUrl) {
		await runRemote(cli.remoteUrl, cli);
		return;
	}

	const dbPath = findDatabasePath(cli.dbPath);
	if (dbPath) {
		runLocal(dbPath, cli);
		return;
	}

	console.error(
		"Error: No local Durable Object SQLite database found in .wrangler/state/v3/do/cadmus-CadmusBotFamilyDO.\n" +
			"To query a cloud environment, pass:\n" +
			`  --prod               (Production: ${PRODUCTION_DEFAULT_URL})\n` +
			`  --preview <branch>   (Preview: https://<branch>-${PREVIEW_HOST_SUFFIX})\n` +
			"  --url <url>          (Custom endpoint URL)\n" +
			"Or provide a local DB path via --db <path>.",
	);
	process.exit(1);
}

main().catch((err) => {
	console.error(
		`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : String(err)}`,
	);
	process.exit(1);
});
