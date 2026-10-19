#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

interface BotRow {
	id: string;
	name: string;
	model: string;
	thinking: string;
	tools_json: string | null;
	root_conversation_id: number;
	created_at: number;
}

interface ChatRow {
	key: string;
	bot_id: string;
	conversation_id: number;
	title: string | null;
	closed: number;
	created_at: number;
}

interface MemoryRow {
	bot_id: string;
	content: string;
	version: number;
	updated_at: number;
}

interface KnowledgeRow {
	bot_id: string;
	slug: string;
	description: string;
	category: string | null;
	version: number;
	body: string;
	updated_at: number;
}

interface SoulRow {
	bot_id: string;
	content: string;
	updated_at: number;
}

interface EntryRow {
	id: number;
	conversation_id: number;
	commit_seq: number;
	record: string;
}

function findDatabasePath(explicitPath?: string): string {
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

	console.error(
		"Error: Could not locate Durable Object SQLite database in .wrangler/state/v3/do/cadmus-CadmusBotFamilyDO.\n" +
			"Provide the path via --db <path>.",
	);
	process.exit(1);
}

function parseCliArgs() {
	const args = process.argv.slice(2);
	const options: {
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
	} = {};

	const positional: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--db") {
			options.dbPath = args[++i];
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

	return options;
}

function main() {
	const cli = parseCliArgs();
	const dbPath = findDatabasePath(cli.dbPath);
	const db = new Database(dbPath, { readonly: true });

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

		console.log(`\n=== BOTS IN FAMILY (${bots.length}) ===`);
		for (const b of bots) {
			console.log(
				`• ${b.id.padEnd(12)} name: ${b.name.padEnd(16)} model: ${b.model.padEnd(16)} rootConv: ${b.root_conversation_id}`,
			);
		}

		console.log(`\n=== CHATS (${chats.length}) ===`);
		for (const c of chats) {
			const dateStr = new Date(c.created_at).toISOString();
			console.log(
				`• ${c.key.padEnd(18)} bot: ${c.bot_id.padEnd(10)} convId: ${String(c.conversation_id).padEnd(5)} created: ${dateStr}`,
			);
		}
		console.log("\nRun with: debug-session <botId|chatKey> [action]\n");
		return;
	}

	const target = cli.target;
	if (!target) {
		console.error(
			"Please specify a botId or chatKey (e.g. 'xai3' or 'xai3:43e02030').",
		);
		process.exit(1);
	}

	let bot: BotRow | null = null;
	let chat: ChatRow | null = null;

	// Check if target matches a chat key or conversation ID
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
		bot =
			db
				.query<BotRow, [string]>(
					"SELECT * FROM cadmus_bots WHERE id = ? LIMIT 1",
				)
				.get(chat.bot_id) ?? null;
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

	const botId = bot ? bot.id : (chat?.bot_id ?? "");
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

			console.log(`\n=== MEMORY.md for bot '${botId}' ===`);
			if (!mem || mem.version === 0 || !mem.content) {
				console.log("(Memory is currently empty / version 0)");
			} else {
				console.log(`Version:    ${mem.version}`);
				console.log(
					`Updated At: ${new Date(mem.updated_at).toISOString()} (${mem.updated_at})`,
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
					console.log(`\n=== knowledge/${doc.slug}.md ===`);
					console.log(`Description: ${doc.description}`);
					if (doc.category) console.log(`Category:    ${doc.category}`);
					console.log(`Version:     ${doc.version}`);
					console.log(`Updated:     ${new Date(doc.updated_at).toISOString()}`);
					console.log("------------------------------------------");
					console.log(doc.body);
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
					`\n=== KNOWLEDGE FILES for bot '${botId}' (${docs.length}) ===`,
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

			console.log(`\n=== SOUL.md for bot '${botId}' ===`);
			if (!soul) {
				console.log("(No custom SOUL.md found)");
			} else {
				console.log(`Updated At: ${new Date(soul.updated_at).toISOString()}`);
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

			console.log(`\n=== CHATS for bot '${botId}' (${chats.length}) ===`);
			for (const c of chats) {
				console.log(
					`• ${c.key.padEnd(20)} convId: ${String(c.conversation_id).padEnd(5)} created: ${new Date(c.created_at).toISOString()} title: ${c.title ?? "(none)"}`,
				);
			}
			break;
		}

		case "conversation": {
			let convId: number | null = chat ? chat.conversation_id : null;

			if (!convId) {
				// Pick the latest chat for this bot
				const latestChat = db
					.query<ChatRow, [string]>(
						"SELECT * FROM cadmus_chats WHERE bot_id = ? ORDER BY created_at DESC LIMIT 1",
					)
					.get(botId);
				if (latestChat) {
					convId = latestChat.conversation_id;
					chat = latestChat;
				} else {
					convId = bot?.root_conversation_id ?? null;
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
				`\n=== CONVERSATION TRANSCRIPT: convId ${convId}${chat ? ` (${chat.key})` : ""} ===\n`,
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
			console.log(` BOT: ${bot ? `${bot.name} (${bot.id})` : botId}`);
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
					`   Version: ${mem.version} (Updated: ${new Date(mem.updated_at).toISOString()})`,
				);
				const preview = mem.content
					.split("\n")
					.map((l) => `   > ${l}`)
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
				const mark = chat && chat.key === c.key ? "-> " : "   ";
				console.log(
					`${mark}• ${c.key.padEnd(20)} convId: ${String(c.conversation_id).padEnd(5)} created: ${new Date(c.created_at).toISOString()}`,
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

main();
