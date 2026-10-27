import { createTwoFilesPatch } from "diff";
import type {
	ScheduleTarget,
	ThinkingLevel,
	ToolsEnvSetting,
} from "../protocol.js";
import type {
	BotFileStore,
	BotRecord,
	BotStore,
	ChatRecord,
	ChatStore,
	ConversationRoute,
	FamilyStore,
	HarvestFileDiff,
	HarvestNote,
	HarvestStore,
	KnowledgeDoc,
	KnowledgeSearchResult,
	MemoryDoc,
	ScheduleRecord,
	ScheduleStore,
} from "./family-interface.js";

export const MAX_MEMORY_BYTES = 8192;
export const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,63}$/;

function parseToolsEnv(
	raw: string | null | undefined,
): ToolsEnvSetting | undefined {
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as ToolsEnvSetting;
		if (!parsed || typeof parsed !== "object") return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

export class CasConflictError extends Error {
	readonly code = "cas_conflict";
	readonly expectedVersion: number;
	readonly actualVersion: number;

	constructor(target: string, expectedVersion: number, actualVersion: number) {
		super(
			`Version conflict on ${target}: expected version ${expectedVersion}, but current version is ${actualVersion}. Read the latest version first.`,
		);
		this.name = "CasConflictError";
		this.expectedVersion = expectedVersion;
		this.actualVersion = actualVersion;
	}
}

export function validateKnowledgeMetadata(
	slug: string,
	description: string,
	category?: string,
): void {
	if (!SLUG_REGEX.test(slug)) {
		throw new Error(
			`Invalid knowledge slug '${slug}': must match /^[a-z0-9][a-z0-9-]{0,63}$/`,
		);
	}
	const trimmedDesc = description.trim();
	if (!trimmedDesc) {
		throw new Error("Knowledge description is required and cannot be empty");
	}
	if (description.includes("\n") || description.includes("\r")) {
		throw new Error("Knowledge description must be a single line");
	}
	if (description.length > 240) {
		throw new Error(
			`Knowledge description must be at most 240 characters (got ${description.length})`,
		);
	}
	if (category !== undefined && category !== "") {
		if (category.includes("\n") || category.includes("\r")) {
			throw new Error("Knowledge category must be a single line");
		}
		if (category.length > 64) {
			throw new Error(
				`Knowledge category must be at most 64 characters (got ${category.length})`,
			);
		}
	}
}

export function validateMemoryContent(content: string): void {
	const byteLength = new TextEncoder().encode(content).byteLength;
	if (byteLength > MAX_MEMORY_BYTES) {
		throw new Error(
			`MEMORY.md exceeds maximum size of ${MAX_MEMORY_BYTES} bytes (got ${byteLength} bytes)`,
		);
	}
	if (content.trimStart().startsWith("---")) {
		throw new Error("MEMORY.md must not start with YAML frontmatter (---)");
	}
}

export function formatKnowledgeMarkdown(doc: KnowledgeDoc): string {
	const lines = ["---", `description: ${doc.description}`];
	if (doc.category) {
		lines.push(`category: ${doc.category}`);
	}
	lines.push(`version: ${doc.version}`, "---", "");
	return lines.join("\n") + doc.body;
}

export function parseKnowledgeMarkdown(raw: string): {
	description: string;
	category?: string;
	version?: number;
	body: string;
} {
	const normalized = raw.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---\n")) {
		throw new Error("Knowledge file must start with YAML frontmatter (---)");
	}
	const closingIdx = normalized.indexOf("\n---\n", 4);
	if (closingIdx === -1) {
		throw new Error("Knowledge file is missing closing YAML frontmatter (---)");
	}
	const fmBlock = normalized.slice(4, closingIdx);
	let body = normalized.slice(closingIdx + 5);
	if (body.startsWith("\n")) {
		body = body.slice(1);
	}

	let description = "";
	let category: string | undefined;
	let version: number | undefined;

	for (const line of fmBlock.split("\n")) {
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const key = line.slice(0, colon).trim();
		const val = line.slice(colon + 1).trim();
		if (key === "description") description = val;
		else if (key === "category" && val) category = val;
		else if (key === "version" && val) {
			const parsed = Number(val);
			if (Number.isInteger(parsed)) version = parsed;
		}
	}

	return { description, category, version, body };
}

type SqlStorage = DurableObjectStorage["sql"];

class SqliteBotStore implements BotStore {
	constructor(private readonly sql: SqlStorage) {}

	listBots(): BotRecord[] {
		const rows = this.sql
			.exec<{
				id: string;
				name: string;
				model: string;
				thinking: string;
				tools_json: string | null;
				timezone?: string | null;
				tools_env_json?: string | null;
				root_conversation_id: number;
				created_at: number;
			}>(
				`SELECT id, name, model, thinking, tools_json, timezone, tools_env_json, root_conversation_id, created_at
         FROM cadmus_bots
         ORDER BY created_at ASC, id ASC`,
			)
			.toArray();
		return rows.map((row) => this.mapRow(row));
	}

	getBot(botId: string): BotRecord | undefined {
		const rows = this.sql
			.exec<{
				id: string;
				name: string;
				model: string;
				thinking: string;
				tools_json: string | null;
				timezone?: string | null;
				tools_env_json?: string | null;
				root_conversation_id: number;
				created_at: number;
			}>(
				`SELECT id, name, model, thinking, tools_json, timezone, tools_env_json, root_conversation_id, created_at
         FROM cadmus_bots
         WHERE id = ?`,
				botId,
			)
			.toArray();
		return rows[0] ? this.mapRow(rows[0]) : undefined;
	}

	upsertBot(bot: BotRecord): void {
		const toolsJson =
			bot.tools !== undefined ? JSON.stringify(bot.tools) : null;
		const toolsEnvJson =
			bot.toolsEnv !== undefined && bot.toolsEnv !== null
				? JSON.stringify(bot.toolsEnv)
				: null;
		this.sql.exec(
			`INSERT INTO cadmus_bots (id, name, model, thinking, tools_json, timezone, tools_env_json, root_conversation_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         model = excluded.model,
         thinking = excluded.thinking,
         tools_json = excluded.tools_json,
         timezone = excluded.timezone,
         tools_env_json = excluded.tools_env_json,
         root_conversation_id = excluded.root_conversation_id`,
			bot.id,
			bot.name,
			bot.model,
			bot.thinking,
			toolsJson,
			bot.timezone,
			toolsEnvJson,
			bot.rootConversationId,
			bot.createdAt,
		);
	}

	deleteBot(botId: string): void {
		this.sql.exec(
			`DELETE FROM cadmus_chats WHERE key LIKE ?`,
			`peer:${botId}:%`,
		);
		this.sql.exec(`DELETE FROM cadmus_bots WHERE id = ?`, botId);
	}

	private mapRow(row: {
		id: string;
		name: string;
		model: string;
		thinking: string;
		tools_json: string | null;
		timezone?: string | null;
		tools_env_json?: string | null;
		root_conversation_id: number;
		created_at: number;
	}): BotRecord {
		const record: BotRecord = {
			id: row.id,
			name: row.name,
			model: row.model,
			thinking: row.thinking as ThinkingLevel,
			timezone: row.timezone ?? "UTC",
			rootConversationId: Number(row.root_conversation_id),
			createdAt: Number(row.created_at),
		};
		if (row.tools_json !== null) {
			record.tools = JSON.parse(row.tools_json) as string[];
		}
		const toolsEnv = parseToolsEnv(row.tools_env_json);
		if (toolsEnv) record.toolsEnv = toolsEnv;
		return record;
	}
}

class SqliteBotFileStore implements BotFileStore {
	constructor(private readonly sql: SqlStorage) {}

	getSoul(botId: string): string {
		const rows = this.sql
			.exec<{ content: string }>(
				`SELECT content FROM cadmus_bot_souls WHERE bot_id = ?`,
				botId,
			)
			.toArray();
		return rows[0]?.content ?? "";
	}

	setSoul(botId: string, content: string): void {
		const now = Date.now();
		this.sql.exec(
			`INSERT INTO cadmus_bot_souls (bot_id, content, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(bot_id) DO UPDATE SET
         content = excluded.content,
         updated_at = excluded.updated_at`,
			botId,
			content,
			now,
		);
	}

	getMemory(botId: string): MemoryDoc {
		const rows = this.sql
			.exec<{ content: string; version: number; updated_at: number }>(
				`SELECT content, version, updated_at FROM cadmus_bot_memories WHERE bot_id = ?`,
				botId,
			)
			.toArray();
		if (!rows[0]) {
			return { content: "", version: 0, updatedAt: 0 };
		}
		return {
			content: rows[0].content,
			version: Number(rows[0].version),
			updatedAt: Number(rows[0].updated_at),
		};
	}

	updateMemory(
		botId: string,
		content: string,
		expectedVersion: number,
	): MemoryDoc {
		validateMemoryContent(content);
		const current = this.getMemory(botId);
		if (current.version !== expectedVersion) {
			throw new CasConflictError("MEMORY.md", expectedVersion, current.version);
		}
		const nextVersion = current.version + 1;
		const now = Date.now();
		this.sql.exec(
			`INSERT INTO cadmus_bot_memories (bot_id, content, version, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(bot_id) DO UPDATE SET
         content = excluded.content,
         version = excluded.version,
         updated_at = excluded.updated_at`,
			botId,
			content,
			nextVersion,
			now,
		);
		return {
			content,
			version: nextVersion,
			updatedAt: now,
		};
	}

	listKnowledge(botId: string, category?: string): KnowledgeDoc[] {
		if (category !== undefined && category !== "") {
			const rows = this.sql
				.exec<{
					slug: string;
					description: string;
					category: string | null;
					version: number;
					body: string;
					updated_at: number;
				}>(
					`SELECT slug, description, category, version, body, updated_at
           FROM cadmus_bot_knowledge
           WHERE bot_id = ? AND category = ?
           ORDER BY slug ASC`,
					botId,
					category,
				)
				.toArray();
			return rows.map((r) => this.mapKnowledge(r));
		}

		const rows = this.sql
			.exec<{
				slug: string;
				description: string;
				category: string | null;
				version: number;
				body: string;
				updated_at: number;
			}>(
				`SELECT slug, description, category, version, body, updated_at
         FROM cadmus_bot_knowledge
         WHERE bot_id = ?
         ORDER BY slug ASC`,
				botId,
			)
			.toArray();
		return rows.map((r) => this.mapKnowledge(r));
	}

	getKnowledge(botId: string, slug: string): KnowledgeDoc | undefined {
		const rows = this.sql
			.exec<{
				slug: string;
				description: string;
				category: string | null;
				version: number;
				body: string;
				updated_at: number;
			}>(
				`SELECT slug, description, category, version, body, updated_at
         FROM cadmus_bot_knowledge
         WHERE bot_id = ? AND slug = ?`,
				botId,
				slug,
			)
			.toArray();
		return rows[0] ? this.mapKnowledge(rows[0]) : undefined;
	}

	updateKnowledge(
		botId: string,
		input: {
			slug: string;
			description: string;
			category?: string;
			body: string;
			expectedVersion: number;
		},
	): KnowledgeDoc {
		validateKnowledgeMetadata(input.slug, input.description, input.category);
		const existing = this.getKnowledge(botId, input.slug);
		const actualVersion = existing ? existing.version : 0;
		if (actualVersion !== input.expectedVersion) {
			throw new CasConflictError(
				`knowledge/${input.slug}.md`,
				input.expectedVersion,
				actualVersion,
			);
		}
		const nextVersion = actualVersion + 1;
		const now = Date.now();
		const categoryVal =
			input.category !== undefined && input.category.trim() !== ""
				? input.category.trim()
				: null;

		this.sql.exec(
			`INSERT INTO cadmus_bot_knowledge (bot_id, slug, description, category, version, body, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(bot_id, slug) DO UPDATE SET
         description = excluded.description,
         category = excluded.category,
         version = excluded.version,
         body = excluded.body,
         updated_at = excluded.updated_at`,
			botId,
			input.slug,
			input.description.trim(),
			categoryVal,
			nextVersion,
			input.body,
			now,
		);

		const doc: KnowledgeDoc = {
			slug: input.slug,
			description: input.description.trim(),
			version: nextVersion,
			body: input.body,
			updatedAt: now,
		};
		if (categoryVal !== null) {
			doc.category = categoryVal;
		}
		return doc;
	}

	deleteKnowledge(botId: string, slug: string, expectedVersion: number): void {
		const existing = this.getKnowledge(botId, slug);
		if (!existing) {
			throw new Error(`Knowledge entry '${slug}' not found`);
		}
		if (existing.version !== expectedVersion) {
			throw new CasConflictError(
				`knowledge/${slug}.md`,
				expectedVersion,
				existing.version,
			);
		}
		this.sql.exec(
			`DELETE FROM cadmus_bot_knowledge WHERE bot_id = ? AND slug = ?`,
			botId,
			slug,
		);
	}

	searchKnowledge(
		botId: string,
		query: string,
		category?: string,
	): KnowledgeSearchResult[] {
		const q = query.trim().toLowerCase();
		const docs = this.listKnowledge(botId, category);
		const results: KnowledgeSearchResult[] = [];

		for (const doc of docs) {
			if (!q) {
				results.push({
					slug: doc.slug,
					description: doc.description,
					category: doc.category,
					version: doc.version,
					snippet: doc.body.slice(0, 200),
				});
				continue;
			}

			const slugMatch = doc.slug.toLowerCase().includes(q);
			const descMatch = doc.description.toLowerCase().includes(q);
			const catMatch = doc.category
				? doc.category.toLowerCase().includes(q)
				: false;
			const bodyLower = doc.body.toLowerCase();
			const bodyIdx = bodyLower.indexOf(q);

			if (slugMatch || descMatch || catMatch || bodyIdx !== -1) {
				let snippet = doc.body.slice(0, 200);
				if (bodyIdx !== -1) {
					const start = Math.max(0, bodyIdx - 60);
					const end = Math.min(doc.body.length, bodyIdx + q.length + 140);
					snippet =
						(start > 0 ? "..." : "") +
						doc.body.slice(start, end) +
						(end < doc.body.length ? "..." : "");
				}
				results.push({
					slug: doc.slug,
					description: doc.description,
					category: doc.category,
					version: doc.version,
					snippet,
				});
			}
		}

		return results;
	}

	snapshotFiles(botId: string): Map<string, string> {
		const map = new Map<string, string>();
		const soul = this.getSoul(botId);
		if (soul) {
			map.set("SOUL.md", soul);
		}
		const memory = this.getMemory(botId);
		if (memory.version > 0 || memory.content) {
			map.set("MEMORY.md", memory.content);
		}
		const knowledgeList = this.listKnowledge(botId);
		for (const doc of knowledgeList) {
			map.set(`knowledge/${doc.slug}.md`, formatKnowledgeMarkdown(doc));
		}
		return map;
	}

	diffSnapshots(
		before: Map<string, string>,
		after: Map<string, string>,
	): HarvestFileDiff[] {
		const allPaths = new Set<string>([...before.keys(), ...after.keys()]);
		const sortedPaths = Array.from(allPaths).sort();
		const diffs: HarvestFileDiff[] = [];

		for (const path of sortedPaths) {
			const oldText = before.get(path) ?? "";
			const newText = after.get(path) ?? "";
			if (oldText === newText) continue;

			const patch = createTwoFilesPatch(path, path, oldText, newText, "", "", {
				context: 2,
			});
			const cleanLines = patch
				.split("\n")
				.filter(
					(line) => !line.startsWith("Index:") && !line.startsWith("==="),
				);
			diffs.push({
				path,
				diff: cleanLines.join("\n").trim(),
			});
		}

		return diffs;
	}

	private mapKnowledge(row: {
		slug: string;
		description: string;
		category: string | null;
		version: number;
		body: string;
		updated_at: number;
	}): KnowledgeDoc {
		const doc: KnowledgeDoc = {
			slug: row.slug,
			description: row.description,
			version: Number(row.version),
			body: row.body,
			updatedAt: Number(row.updated_at),
		};
		if (row.category !== null && row.category !== "") {
			doc.category = row.category;
		}
		return doc;
	}
}

class SqliteChatStore implements ChatStore {
	constructor(private readonly sql: SqlStorage) {}

	listChats(botId?: string): ChatRecord[] {
		if (botId) {
			const rows = this.sql
				.exec<{
					key: string;
					bot_id: string;
					conversation_id: number;
					title: string | null;
					thinking: string | null;
					closed: number;
					created_at: number;
				}>(
					`SELECT key, bot_id, conversation_id, title, thinking, closed, tools_env_json, created_at
           FROM cadmus_chats
           WHERE bot_id = ?
           ORDER BY created_at ASC, key ASC`,
					botId,
				)
				.toArray();
			return rows.map((r) => this.mapRow(r));
		}

		const rows = this.sql
			.exec<{
				key: string;
				bot_id: string;
				conversation_id: number;
				title: string | null;
				thinking: string | null;
				closed: number;
				created_at: number;
			}>(
				`SELECT key, bot_id, conversation_id, title, thinking, closed, tools_env_json, created_at
         FROM cadmus_chats
         ORDER BY created_at ASC, key ASC`,
			)
			.toArray();
		return rows.map((r) => this.mapRow(r));
	}

	getChat(key: string): ChatRecord | undefined {
		const rows = this.sql
			.exec<{
				key: string;
				bot_id: string;
				conversation_id: number;
				title: string | null;
				thinking: string | null;
				closed: number;
				created_at: number;
			}>(
				`SELECT key, bot_id, conversation_id, title, thinking, closed, tools_env_json, created_at
         FROM cadmus_chats
         WHERE key = ?`,
				key,
			)
			.toArray();
		return rows[0] ? this.mapRow(rows[0]) : undefined;
	}

	getChatByConversationId(conversationId: number): ChatRecord | undefined {
		const rows = this.sql
			.exec<{
				key: string;
				bot_id: string;
				conversation_id: number;
				title: string | null;
				thinking: string | null;
				closed: number;
				created_at: number;
			}>(
				`SELECT key, bot_id, conversation_id, title, thinking, closed, tools_env_json, created_at
         FROM cadmus_chats
         WHERE conversation_id = ?
         LIMIT 1`,
				conversationId,
			)
			.toArray();
		return rows[0] ? this.mapRow(rows[0]) : undefined;
	}

	upsertChat(chat: ChatRecord): void {
		const toolsEnvJson =
			chat.toolsEnv !== undefined && chat.toolsEnv !== null
				? JSON.stringify(chat.toolsEnv)
				: null;
		this.sql.exec(
			`INSERT INTO cadmus_chats (key, bot_id, conversation_id, title, thinking, closed, tools_env_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         bot_id = excluded.bot_id,
         conversation_id = excluded.conversation_id,
         title = excluded.title,
         thinking = excluded.thinking,
         closed = excluded.closed,
         tools_env_json = excluded.tools_env_json`,
			chat.key,
			chat.botId,
			chat.conversationId,
			chat.title ?? null,
			chat.thinking ?? null,
			chat.closed ? 1 : 0,
			toolsEnvJson,
			chat.createdAt,
		);
	}

	deleteChat(key: string): void {
		this.sql.exec(`DELETE FROM cadmus_chats WHERE key = ?`, key);
	}

	private mapRow(row: {
		key: string;
		bot_id: string;
		conversation_id: number;
		title: string | null;
		thinking: string | null;
		closed: number;
		created_at: number;
	}): ChatRecord {
		const rec: ChatRecord = {
			key: row.key,
			botId: row.bot_id,
			conversationId: Number(row.conversation_id),
			createdAt: Number(row.created_at),
		};
		if (row.title !== null) {
			rec.title = row.title;
		}
		if (row.thinking !== null) {
			rec.thinking = row.thinking as ThinkingLevel;
		}
		if (row.closed) {
			rec.closed = true;
		}
		const toolsEnv = parseToolsEnv(
			(row as { tools_env_json?: string | null }).tools_env_json,
		);
		if (toolsEnv) rec.toolsEnv = toolsEnv;
		return rec;
	}

	listConversationRoutes(chatKey: string): ConversationRoute[] {
		const rows = this.sql
			.exec<{
				conversation_id: number;
				chat_key: string;
				bot_id: string;
				tools_env_enabled: number;
			}>(
				`SELECT conversation_id, chat_key, bot_id, tools_env_enabled
         FROM cadmus_chat_conversations WHERE chat_key = ?`,
				chatKey,
			)
			.toArray();
		return rows.map((row) => ({
			conversationId: Number(row.conversation_id),
			chatKey: row.chat_key,
			botId: row.bot_id,
			toolsEnvEnabled: row.tools_env_enabled !== 0,
		}));
	}

	getConversationRoute(conversationId: number): ConversationRoute | undefined {
		const rows = this.sql
			.exec<{
				conversation_id: number;
				chat_key: string;
				bot_id: string;
				tools_env_enabled: number;
			}>(
				`SELECT conversation_id, chat_key, bot_id, tools_env_enabled
         FROM cadmus_chat_conversations WHERE conversation_id = ?`,
				conversationId,
			)
			.toArray();
		const row = rows[0];
		if (!row) return undefined;
		return {
			conversationId: Number(row.conversation_id),
			chatKey: row.chat_key,
			botId: row.bot_id,
			toolsEnvEnabled: row.tools_env_enabled !== 0,
		};
	}

	recordConversationRoute(route: ConversationRoute): void {
		this.sql.exec(
			`INSERT INTO cadmus_chat_conversations (conversation_id, chat_key, bot_id, tools_env_enabled)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         chat_key = excluded.chat_key,
         bot_id = excluded.bot_id,
         tools_env_enabled = excluded.tools_env_enabled`,
			route.conversationId,
			route.chatKey,
			route.botId,
			route.toolsEnvEnabled ? 1 : 0,
		);
	}

	setConversationToolsEnvEnabled(
		conversationId: number,
		enabled: boolean,
	): void {
		this.sql.exec(
			`UPDATE cadmus_chat_conversations SET tools_env_enabled = ? WHERE conversation_id = ?`,
			enabled ? 1 : 0,
			conversationId,
		);
	}

	deleteConversationRoute(conversationId: number): void {
		this.sql.exec(
			`DELETE FROM cadmus_chat_conversations WHERE conversation_id = ?`,
			conversationId,
		);
	}

	deleteConversationRoutesForChat(chatKey: string): void {
		this.sql.exec(
			`DELETE FROM cadmus_chat_conversations WHERE chat_key = ?`,
			chatKey,
		);
	}

	deleteConversationRoutesForBot(botId: string): void {
		this.sql.exec(
			`DELETE FROM cadmus_chat_conversations WHERE bot_id = ?`,
			botId,
		);
	}

	copyConversationRoute(parentId: number, childId: number): void {
		this.sql.exec(
			`INSERT OR IGNORE INTO cadmus_chat_conversations (conversation_id, chat_key, bot_id, tools_env_enabled)
       SELECT ?, chat_key, bot_id, tools_env_enabled
       FROM cadmus_chat_conversations
       WHERE conversation_id = ?`,
			childId,
			parentId,
		);
	}
}

type ScheduleRow = {
	id: string;
	bot_id: string;
	name: string | null;
	kind: "relative" | "absolute" | "cron";
	input: string;
	next_run: number;
	text: string;
	target_json: string;
	thinking: string | null;
	enabled: number;
	internal: number;
};

class SqliteScheduleStore implements ScheduleStore {
	constructor(private readonly sql: SqlStorage) {}

	listSchedules(botId?: string, includeInternal = false): ScheduleRecord[] {
		if (botId) {
			const rows = includeInternal
				? this.sql
						.exec<ScheduleRow>(
							`SELECT id, bot_id, name, kind, input, next_run, text, target_json, thinking, enabled, internal
               FROM cadmus_schedules
               WHERE bot_id = ?
               ORDER BY id ASC`,
							botId,
						)
						.toArray()
				: this.sql
						.exec<ScheduleRow>(
							`SELECT id, bot_id, name, kind, input, next_run, text, target_json, thinking, enabled, internal
               FROM cadmus_schedules
               WHERE bot_id = ? AND internal = 0
               ORDER BY id ASC`,
							botId,
						)
						.toArray();
			return rows.map((r) => this.mapRow(r));
		}

		const rows = includeInternal
			? this.sql
					.exec<ScheduleRow>(
						`SELECT id, bot_id, name, kind, input, next_run, text, target_json, thinking, enabled, internal
             FROM cadmus_schedules
             ORDER BY id ASC`,
					)
					.toArray()
			: this.sql
					.exec<ScheduleRow>(
						`SELECT id, bot_id, name, kind, input, next_run, text, target_json, thinking, enabled, internal
             FROM cadmus_schedules
             WHERE internal = 0
             ORDER BY id ASC`,
					)
					.toArray();
		return rows.map((r) => this.mapRow(r));
	}

	getSchedule(id: string): ScheduleRecord | undefined {
		const rows = this.sql
			.exec<ScheduleRow>(
				`SELECT id, bot_id, name, kind, input, next_run, text, target_json, thinking, enabled, internal
         FROM cadmus_schedules
         WHERE id = ?`,
				id,
			)
			.toArray();
		return rows[0] ? this.mapRow(rows[0]) : undefined;
	}

	upsertSchedule(schedule: ScheduleRecord): void {
		this.sql.exec(
			`INSERT INTO cadmus_schedules (
         id, bot_id, name, kind, input, next_run, text, target_json, thinking, enabled, internal
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         bot_id = excluded.bot_id,
         name = excluded.name,
         kind = excluded.kind,
         input = excluded.input,
         next_run = excluded.next_run,
         text = excluded.text,
         target_json = excluded.target_json,
         thinking = excluded.thinking,
         enabled = excluded.enabled,
         internal = excluded.internal`,
			schedule.id,
			schedule.botId,
			schedule.name ?? null,
			schedule.kind,
			String(schedule.input),
			schedule.nextRun,
			schedule.text,
			JSON.stringify(schedule.target),
			schedule.thinking ?? null,
			schedule.enabled ? 1 : 0,
			schedule.internal ? 1 : 0,
		);
	}

	deleteSchedule(id: string): void {
		this.sql.exec(`DELETE FROM cadmus_schedules WHERE id = ?`, id);
	}

	recordFire(scheduleId: string, fireTime: number): void {
		this.sql.exec(
			`INSERT OR IGNORE INTO cadmus_schedule_fires (schedule_id, fire_time) VALUES (?, ?)`,
			scheduleId,
			fireTime,
		);
	}

	hasFired(scheduleId: string, fireTime: number): boolean {
		const rows = this.sql
			.exec<{ fire_time: number }>(
				`SELECT fire_time FROM cadmus_schedule_fires WHERE schedule_id = ? AND fire_time = ?`,
				scheduleId,
				fireTime,
			)
			.toArray();
		return rows.length > 0;
	}

	private mapRow(row: ScheduleRow): ScheduleRecord {
		const rec: ScheduleRecord = {
			id: row.id,
			botId: row.bot_id,
			kind: row.kind,
			input: row.input,
			nextRun: Number(row.next_run),
			inSeconds: Math.max(
				0,
				Math.round((Number(row.next_run) - Date.now()) / 1000),
			),
			recurring: row.kind === "cron",
			text: row.text,
			target: JSON.parse(row.target_json) as ScheduleTarget,
			enabled: Boolean(row.enabled),
		};
		if (row.name !== null) rec.name = row.name;
		if (row.thinking !== null) rec.thinking = row.thinking as ThinkingLevel;
		if (row.internal) rec.internal = true;
		return rec;
	}
}

class SqliteHarvestStore implements HarvestStore {
	constructor(private readonly sql: SqlStorage) {}

	getWatermark(chatKey: string): number {
		const rows = this.sql
			.exec<{ entry_id: number }>(
				`SELECT entry_id FROM cadmus_harvest_watermarks WHERE chat_key = ?`,
				chatKey,
			)
			.toArray();
		return rows[0] ? Number(rows[0].entry_id) : 0;
	}

	setWatermark(chatKey: string, entryId: number): void {
		this.sql.exec(
			`INSERT INTO cadmus_harvest_watermarks (chat_key, entry_id)
       VALUES (?, ?)
       ON CONFLICT(chat_key) DO UPDATE SET entry_id = excluded.entry_id`,
			chatKey,
			entryId,
		);
	}

	addNote(note: HarvestNote): void {
		this.sql.exec(
			`INSERT INTO cadmus_harvest_notes (chat_key, at_entry, files_json, when_ms)
       VALUES (?, ?, ?, ?)`,
			note.chatKey,
			note.at,
			JSON.stringify(note.files),
			note.when,
		);
	}

	listNotes(chatKey: string): HarvestNote[] {
		const rows = this.sql
			.exec<{
				chat_key: string;
				at_entry: number;
				files_json: string;
				when_ms: number;
			}>(
				`SELECT chat_key, at_entry, files_json, when_ms
         FROM cadmus_harvest_notes
         WHERE chat_key = ?
         ORDER BY id ASC`,
				chatKey,
			)
			.toArray();
		return rows.map((r) => ({
			chatKey: r.chat_key,
			at: Number(r.at_entry),
			files: JSON.parse(r.files_json) as HarvestFileDiff[],
			when: Number(r.when_ms),
		}));
	}
}

export class SqliteFamilyStore implements FamilyStore {
	readonly bots: BotStore;
	readonly files: BotFileStore;
	readonly chats: ChatStore;
	readonly schedules: ScheduleStore;
	readonly harvest: HarvestStore;
	private initialized = false;

	constructor(private readonly sql: SqlStorage) {
		this.bots = new SqliteBotStore(sql);
		this.files = new SqliteBotFileStore(sql);
		this.chats = new SqliteChatStore(sql);
		this.schedules = new SqliteScheduleStore(sql);
		this.harvest = new SqliteHarvestStore(sql);
	}

	ensureSchema(): void {
		if (this.initialized) return;
		this.sql.exec(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS cadmus_bots (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        model TEXT NOT NULL,
        thinking TEXT NOT NULL,
        tools_json TEXT,
        timezone TEXT NOT NULL DEFAULT 'UTC',
        tools_env_json TEXT,
        root_conversation_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cadmus_bot_souls (
        bot_id TEXT PRIMARY KEY REFERENCES cadmus_bots(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cadmus_bot_memories (
        bot_id TEXT PRIMARY KEY REFERENCES cadmus_bots(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cadmus_bot_knowledge (
        bot_id TEXT NOT NULL REFERENCES cadmus_bots(id) ON DELETE CASCADE,
        slug TEXT NOT NULL,
        description TEXT NOT NULL,
        category TEXT,
        version INTEGER NOT NULL,
        body TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (bot_id, slug)
      );

      CREATE INDEX IF NOT EXISTS idx_cadmus_bot_knowledge_cat
        ON cadmus_bot_knowledge(bot_id, category);

      CREATE TABLE IF NOT EXISTS cadmus_chats (
        key TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES cadmus_bots(id) ON DELETE CASCADE,
        conversation_id INTEGER NOT NULL,
        title TEXT,
        thinking TEXT,
        closed INTEGER NOT NULL DEFAULT 0,
        tools_env_json TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cadmus_chats_bot
        ON cadmus_chats(bot_id);

      CREATE INDEX IF NOT EXISTS idx_cadmus_chats_conv
        ON cadmus_chats(conversation_id);

      CREATE TABLE IF NOT EXISTS cadmus_chat_conversations (
        conversation_id INTEGER PRIMARY KEY,
        chat_key TEXT NOT NULL REFERENCES cadmus_chats(key) ON DELETE CASCADE,
        bot_id TEXT NOT NULL REFERENCES cadmus_bots(id) ON DELETE CASCADE,
        tools_env_enabled INTEGER NOT NULL DEFAULT 1
      );

      CREATE INDEX IF NOT EXISTS idx_cadmus_chat_conversations_chat
        ON cadmus_chat_conversations(chat_key);

      CREATE TABLE IF NOT EXISTS cadmus_schedules (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES cadmus_bots(id) ON DELETE CASCADE,
        name TEXT,
        kind TEXT NOT NULL,
        input TEXT NOT NULL DEFAULT '',
        next_run INTEGER NOT NULL,
        text TEXT NOT NULL,
        target_json TEXT NOT NULL,
        thinking TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        internal INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_cadmus_schedules_bot
        ON cadmus_schedules(bot_id, internal);

      CREATE TABLE IF NOT EXISTS cadmus_schedule_fires (
        schedule_id TEXT NOT NULL REFERENCES cadmus_schedules(id) ON DELETE CASCADE,
        fire_time INTEGER NOT NULL,
        PRIMARY KEY (schedule_id, fire_time)
      );

      CREATE TABLE IF NOT EXISTS cadmus_harvest_watermarks (
        chat_key TEXT PRIMARY KEY REFERENCES cadmus_chats(key) ON DELETE CASCADE,
        entry_id INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cadmus_harvest_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_key TEXT NOT NULL REFERENCES cadmus_chats(key) ON DELETE CASCADE,
        at_entry INTEGER NOT NULL,
        files_json TEXT NOT NULL,
        when_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cadmus_harvest_notes_chat
        ON cadmus_harvest_notes(chat_key, id);
    `);

		this.initialized = true;
	}
}
