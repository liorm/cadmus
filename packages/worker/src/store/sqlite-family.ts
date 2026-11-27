import { createTwoFilesPatch } from "diff";
import type {
	BotMetadata,
	ScheduleTarget,
	ThinkingLevel,
	ToolsEnvSetting,
} from "../protocol.js";
import {
	type BotFileStore,
	type BotRecord,
	type BotStore,
	type ChatKind,
	type ChatRecord,
	type ChatStore,
	type ChatTask,
	type ConversationRoute,
	type ConversationRouteKind,
	type Deadlines,
	type FamilyStore,
	type GroupChatRecord,
	type GroupMessage,
	type GroupStore,
	type HarvestFileDiff,
	type HarvestNote,
	type HarvestStore,
	type MemoryDoc,
	primaryChatKey,
	type ScheduleRecord,
	type ScheduleStore,
	type SkillDoc,
	type TaskLoopState,
	type TaskStore,
} from "./family-interface.js";

const CHAT_SELECT = `key, bot_id, conversation_id, title, thinking, closed, tools_env_json, created_at, harvest_enabled, kind, deadlines_json, deleted_at, origin_chat_key`;

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

function parseMetadata(
	raw: string | null | undefined,
): BotMetadata | undefined {
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as BotMetadata;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return undefined;
		}
		return Object.keys(parsed).length > 0 ? parsed : undefined;
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

export function validateSkillMetadata(
	slug: string,
	description: string,
	category?: string,
): void {
	if (!SLUG_REGEX.test(slug)) {
		throw new Error(
			`Invalid skill slug '${slug}': must match /^[a-z0-9][a-z0-9-]{0,63}$/`,
		);
	}
	const trimmedDesc = description.trim();
	if (!trimmedDesc) {
		throw new Error("Skill description is required and cannot be empty");
	}
	if (description.includes("\n") || description.includes("\r")) {
		throw new Error("Skill description must be a single line");
	}
	if (description.length > 240) {
		throw new Error(
			`Skill description must be at most 240 characters (got ${description.length})`,
		);
	}
	if (category !== undefined && category !== "") {
		if (category.includes("\n") || category.includes("\r")) {
			throw new Error("Skill category must be a single line");
		}
		if (category.length > 64) {
			throw new Error(
				`Skill category must be at most 64 characters (got ${category.length})`,
			);
		}
	}
}

export function validateMemoryContent(content: string): void {
	const byteLength = new TextEncoder().encode(content).byteLength;
	if (byteLength > MAX_MEMORY_BYTES) {
		throw new Error(
			`/.cadmus/MEMORY.md exceeds maximum size of ${MAX_MEMORY_BYTES} bytes (got ${byteLength} bytes)`,
		);
	}
	if (content.trimStart().startsWith("---")) {
		throw new Error(
			"/.cadmus/MEMORY.md must not start with YAML frontmatter (---)",
		);
	}
}

export function formatSkillMarkdown(doc: SkillDoc): string {
	const lines = ["---", `name: ${doc.slug}`, `description: ${doc.description}`];
	if (doc.category) {
		lines.push(`category: ${doc.category}`);
	}
	lines.push("---", "");
	return doc.body ? `${lines.join("\n")}\n${doc.body}` : lines.join("\n");
}

export function parseSkillMarkdown(raw: string): {
	name?: string;
	description: string;
	category?: string;
	version?: number;
	body: string;
} {
	const normalized = raw.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---\n")) {
		throw new Error("Skill file must start with YAML frontmatter (---)");
	}
	let closingIdx = normalized.indexOf("\n---\n", 4);
	let bodyOffset = 5;
	if (closingIdx === -1) {
		if (normalized.endsWith("\n---")) {
			closingIdx = normalized.length - 4;
			bodyOffset = 4;
		} else {
			throw new Error("Skill file is missing closing YAML frontmatter (---)");
		}
	}
	const fmBlock = normalized.slice(4, closingIdx);
	let body = normalized.slice(closingIdx + bodyOffset);
	if (body.startsWith("\n")) {
		body = body.slice(1);
	}

	let name: string | undefined;
	let description = "";
	let category: string | undefined;
	let version: number | undefined;

	for (const line of fmBlock.split("\n")) {
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const key = line.slice(0, colon).trim();
		const val = line.slice(colon + 1).trim();
		if (key === "name" && val) name = val;
		else if (key === "description") description = val;
		else if (key === "category" && val) category = val;
		else if (key === "version" && val) {
			const parsed = Number(val);
			if (Number.isInteger(parsed)) version = parsed;
		}
	}

	return { name, description, category, version, body };
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
				metadata_json?: string | null;
				root_conversation_id: number;
				created_at: number;
			}>(
				`SELECT id, name, model, thinking, tools_json, timezone, tools_env_json, metadata_json, root_conversation_id, created_at
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
				metadata_json?: string | null;
				root_conversation_id: number;
				created_at: number;
			}>(
				`SELECT id, name, model, thinking, tools_json, timezone, tools_env_json, metadata_json, root_conversation_id, created_at
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
		const metadataJson =
			bot.metadata !== undefined && Object.keys(bot.metadata).length > 0
				? JSON.stringify(bot.metadata)
				: null;
		this.sql.exec(
			`INSERT INTO cadmus_bots (id, name, model, thinking, tools_json, timezone, tools_env_json, metadata_json, root_conversation_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         model = excluded.model,
         thinking = excluded.thinking,
         tools_json = excluded.tools_json,
         timezone = excluded.timezone,
         tools_env_json = excluded.tools_env_json,
         metadata_json = excluded.metadata_json,
         root_conversation_id = excluded.root_conversation_id`,
			bot.id,
			bot.name,
			bot.model,
			bot.thinking,
			toolsJson,
			bot.timezone,
			toolsEnvJson,
			metadataJson,
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
		metadata_json?: string | null;
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
			primaryChatKey: primaryChatKey(row.id),
			createdAt: Number(row.created_at),
		};
		if (row.tools_json !== null) {
			record.tools = JSON.parse(row.tools_json) as string[];
		}
		const toolsEnv = parseToolsEnv(row.tools_env_json);
		if (toolsEnv) record.toolsEnv = toolsEnv;
		const metadata = parseMetadata(row.metadata_json);
		if (metadata) record.metadata = metadata;
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
		expectedVersion?: number,
	): MemoryDoc {
		validateMemoryContent(content);
		const current = this.getMemory(botId);
		if (expectedVersion !== undefined && current.version !== expectedVersion) {
			throw new CasConflictError(
				"/.cadmus/MEMORY.md",
				expectedVersion,
				current.version,
			);
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

	listSkills(botId: string, category?: string): SkillDoc[] {
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
           FROM cadmus_bot_skills
           WHERE bot_id = ? AND category = ?
           ORDER BY slug ASC`,
					botId,
					category,
				)
				.toArray();
			return rows.map((r) => this.mapSkill(r));
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
         FROM cadmus_bot_skills
         WHERE bot_id = ?
         ORDER BY slug ASC`,
				botId,
			)
			.toArray();
		return rows.map((r) => this.mapSkill(r));
	}

	getSkill(botId: string, slug: string): SkillDoc | undefined {
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
         FROM cadmus_bot_skills
         WHERE bot_id = ? AND slug = ?`,
				botId,
				slug,
			)
			.toArray();
		return rows[0] ? this.mapSkill(rows[0]) : undefined;
	}

	updateSkill(
		botId: string,
		input: {
			slug: string;
			description: string;
			category?: string;
			body: string;
			expectedVersion?: number;
		},
	): SkillDoc {
		validateSkillMetadata(input.slug, input.description, input.category);
		const existing = this.getSkill(botId, input.slug);
		const actualVersion = existing ? existing.version : 0;
		if (
			input.expectedVersion !== undefined &&
			actualVersion !== input.expectedVersion
		) {
			throw new CasConflictError(
				`/.cadmus/skills/bot/${input.slug}/SKILL.md`,
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
			`INSERT INTO cadmus_bot_skills (bot_id, slug, description, category, version, body, updated_at)
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

		const doc: SkillDoc = {
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

	deleteSkill(botId: string, slug: string, expectedVersion?: number): void {
		const existing = this.getSkill(botId, slug);
		if (!existing) {
			throw new Error(`Skill '${slug}' not found`);
		}
		if (expectedVersion !== undefined && existing.version !== expectedVersion) {
			throw new CasConflictError(
				`/.cadmus/skills/bot/${slug}/SKILL.md`,
				expectedVersion,
				existing.version,
			);
		}
		this.sql.exec(
			`DELETE FROM cadmus_bot_skills WHERE bot_id = ? AND slug = ?`,
			botId,
			slug,
		);
	}

	listFamilySkills(category?: string): SkillDoc[] {
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
           FROM cadmus_family_skills
           WHERE category = ?
           ORDER BY slug ASC`,
					category,
				)
				.toArray();
			return rows.map((r) => this.mapSkill(r));
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
         FROM cadmus_family_skills
         ORDER BY slug ASC`,
			)
			.toArray();
		return rows.map((r) => this.mapSkill(r));
	}

	getFamilySkill(slug: string): SkillDoc | undefined {
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
         FROM cadmus_family_skills
         WHERE slug = ?`,
				slug,
			)
			.toArray();
		return rows[0] ? this.mapSkill(rows[0]) : undefined;
	}

	updateFamilySkill(input: {
		slug: string;
		description: string;
		category?: string;
		body: string;
		expectedVersion?: number;
	}): SkillDoc {
		validateSkillMetadata(input.slug, input.description, input.category);
		const existing = this.getFamilySkill(input.slug);
		const actualVersion = existing ? existing.version : 0;
		if (
			input.expectedVersion !== undefined &&
			actualVersion !== input.expectedVersion
		) {
			throw new CasConflictError(
				`/.cadmus/skills/family/${input.slug}/SKILL.md`,
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
			`INSERT INTO cadmus_family_skills (slug, description, category, version, body, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET
         description = excluded.description,
         category = excluded.category,
         version = excluded.version,
         body = excluded.body,
         updated_at = excluded.updated_at`,
			input.slug,
			input.description.trim(),
			categoryVal,
			nextVersion,
			input.body,
			now,
		);

		const doc: SkillDoc = {
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

	deleteFamilySkill(slug: string, expectedVersion?: number): void {
		const existing = this.getFamilySkill(slug);
		if (!existing) {
			throw new Error(`Family skill '${slug}' not found`);
		}
		if (expectedVersion !== undefined && existing.version !== expectedVersion) {
			throw new CasConflictError(
				`/.cadmus/skills/family/${slug}/SKILL.md`,
				expectedVersion,
				existing.version,
			);
		}
		this.sql.exec(`DELETE FROM cadmus_family_skills WHERE slug = ?`, slug);
	}

	snapshotFiles(botId: string): Map<string, string> {
		const map = new Map<string, string>();
		const soul = this.getSoul(botId);
		if (soul) {
			map.set("/.cadmus/SOUL.md", soul);
		}
		const memory = this.getMemory(botId);
		if (memory.version > 0 || memory.content) {
			map.set("/.cadmus/MEMORY.md", memory.content);
		}
		const skillsList = this.listSkills(botId);
		for (const doc of skillsList) {
			map.set(
				`/.cadmus/skills/bot/${doc.slug}/SKILL.md`,
				formatSkillMarkdown(doc),
			);
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

	private mapSkill(row: {
		slug: string;
		description: string;
		category: string | null;
		version: number;
		body: string;
		updated_at: number;
	}): SkillDoc {
		const doc: SkillDoc = {
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

type ChatRow = {
	key: string;
	bot_id: string;
	conversation_id: number;
	title: string | null;
	thinking: string | null;
	closed: number;
	tools_env_json?: string | null;
	created_at: number;
	harvest_enabled?: number | null;
	kind?: string | null;
	deadlines_json?: string | null;
	deleted_at?: number | null;
	origin_chat_key?: string | null;
};

class SqliteChatStore implements ChatStore {
	constructor(private readonly sql: SqlStorage) {}

	listChats(
		filter?:
			| string
			| {
					botId?: string;
					kinds?: readonly ChatKind[];
			  },
	): ChatRecord[] {
		const botId = typeof filter === "string" ? filter : filter?.botId;
		const kinds = typeof filter === "object" ? filter?.kinds : undefined;

		const conditions: string[] = [];
		const params: (string | number)[] = [];

		if (botId) {
			conditions.push("bot_id = ?");
			params.push(botId);
		}

		if (kinds && kinds.length > 0) {
			const placeholders = kinds.map(() => "?").join(", ");
			conditions.push(`kind IN (${placeholders})`);
			params.push(...kinds);
		}

		const whereClause =
			conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const sql = `SELECT ${CHAT_SELECT}
         FROM cadmus_chats
         ${whereClause}
         ORDER BY created_at ASC, key ASC`;

		const rows = this.sql.exec<ChatRow>(sql, ...params).toArray();

		return rows.map((r) => this.mapRow(r));
	}

	getChat(key: string): ChatRecord | undefined {
		const rows = this.sql
			.exec<ChatRow>(
				`SELECT ${CHAT_SELECT}
         FROM cadmus_chats
         WHERE key = ?`,
				key,
			)
			.toArray();
		return rows[0] ? this.mapRow(rows[0]) : undefined;
	}

	getChatByConversationId(conversationId: number): ChatRecord | undefined {
		const rows = this.sql
			.exec<ChatRow>(
				`SELECT ${CHAT_SELECT}
         FROM cadmus_chats
         WHERE conversation_id = ?
         LIMIT 1`,
				conversationId,
			)
			.toArray();
		return rows[0] ? this.mapRow(rows[0]) : undefined;
	}

	listChildChats(originChatKey: string): ChatRecord[] {
		const rows = this.sql
			.exec<ChatRow>(
				`SELECT ${CHAT_SELECT}
         FROM cadmus_chats
         WHERE origin_chat_key = ?
         ORDER BY created_at ASC, key ASC`,
				originChatKey,
			)
			.toArray();
		return rows.map((r) => this.mapRow(r));
	}

	upsertChat(chat: ChatRecord): void {
		const toolsEnvJson =
			chat.toolsEnv !== undefined && chat.toolsEnv !== null
				? JSON.stringify(chat.toolsEnv)
				: null;
		const kind =
			chat.kind ?? (chat.key.startsWith("gmem:") ? "group-member" : "direct");
		this.sql.exec(
			`INSERT INTO cadmus_chats (key, bot_id, conversation_id, title, thinking, closed, tools_env_json, created_at, harvest_enabled, kind, deleted_at, origin_chat_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(key) DO UPDATE SET
         bot_id = excluded.bot_id,
         conversation_id = excluded.conversation_id,
         title = excluded.title,
         thinking = excluded.thinking,
         closed = excluded.closed,
         tools_env_json = excluded.tools_env_json,
         harvest_enabled = excluded.harvest_enabled,
         kind = excluded.kind,
         deleted_at = NULL,
         origin_chat_key = excluded.origin_chat_key`,
			chat.key,
			chat.botId,
			chat.conversationId,
			chat.title ?? null,
			chat.thinking ?? null,
			chat.closed ? 1 : 0,
			toolsEnvJson,
			chat.createdAt,
			chat.harvest === false ? 0 : 1,
			kind,
			chat.originChatKey ?? null,
		);
	}

	setTurnRoot(chatKey: string, rootRequestId: string): void {
		this.sql.exec(
			`INSERT INTO cadmus_turn_roots (chat_key, root_request_id)
       VALUES (?, ?)
       ON CONFLICT(chat_key) DO UPDATE SET root_request_id = excluded.root_request_id`,
			chatKey,
			rootRequestId,
		);
	}

	setEntryAuthor(chatKey: string, entryId: number, userId: string): void {
		this.sql.exec(
			`INSERT OR IGNORE INTO cadmus_entry_authors (chat_key, entry_id, user_id)
       VALUES (?, ?, ?)`,
			chatKey,
			entryId,
			userId,
		);
	}

	listEntryAuthors(chatKey: string): Map<number, string> {
		const authors = new Map<number, string>();
		for (const row of this.sql.exec<{ entry_id: number; user_id: string }>(
			`SELECT entry_id, user_id FROM cadmus_entry_authors WHERE chat_key = ?`,
			chatKey,
		)) {
			authors.set(Number(row.entry_id), row.user_id);
		}
		return authors;
	}

	getTurnRoot(chatKey: string): string | undefined {
		const rows = this.sql
			.exec<{ root_request_id: string }>(
				`SELECT root_request_id FROM cadmus_turn_roots WHERE chat_key = ?`,
				chatKey,
			)
			.toArray();
		return rows[0]?.root_request_id;
	}

	deleteChat(key: string): void {
		this.sql.exec(`DELETE FROM cadmus_chats WHERE key = ?`, key);
	}

	setDeadlines(chatKey: string, deadlines: Deadlines | null): void {
		this.sql.exec(
			`UPDATE cadmus_chats SET deadlines_json = ? WHERE key = ?`,
			deadlines ? JSON.stringify(deadlines) : null,
			chatKey,
		);
	}

	private mapRow(row: ChatRow): ChatRecord {
		const kind: ChatKind =
			(row.kind as ChatKind) ||
			(row.key.startsWith("gmem:") ? "group-member" : "direct");
		const rec: ChatRecord = {
			key: row.key,
			botId: row.bot_id,
			conversationId: Number(row.conversation_id),
			createdAt: Number(row.created_at),
			kind,
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
		if (row.origin_chat_key) {
			rec.originChatKey = row.origin_chat_key;
		}
		const toolsEnv = parseToolsEnv(row.tools_env_json);
		if (toolsEnv) rec.toolsEnv = toolsEnv;
		const harvestEnabled = row.harvest_enabled;
		if (harvestEnabled === 0) rec.harvest = false;
		if (kind === "group-member") {
			rec.readOnly = true;
		}
		if (row.deadlines_json) {
			try {
				const parsed = JSON.parse(row.deadlines_json) as Deadlines;
				if (parsed && typeof parsed === "object") rec.deadlines = parsed;
			} catch {
				// ignore
			}
		}
		return rec;
	}

	listConversationRoutes(chatKey: string): ConversationRoute[] {
		const rows = this.sql
			.exec<{
				conversation_id: number;
				chat_key: string;
				bot_id: string;
				tools_env_enabled: number;
				route_kind?: string | null;
			}>(
				`SELECT conversation_id, chat_key, bot_id, tools_env_enabled, route_kind
         FROM cadmus_chat_conversations WHERE chat_key = ?`,
				chatKey,
			)
			.toArray();
		return rows.map((row) => ({
			conversationId: Number(row.conversation_id),
			chatKey: row.chat_key,
			botId: row.bot_id,
			toolsEnvEnabled: row.tools_env_enabled !== 0,
			kind: (row.route_kind as ConversationRouteKind) || "direct",
		}));
	}

	listConversationRoutesForBot(botId: string): ConversationRoute[] {
		const rows = this.sql
			.exec<{
				conversation_id: number;
				chat_key: string;
				bot_id: string;
				tools_env_enabled: number;
				route_kind?: string | null;
			}>(
				`SELECT conversation_id, chat_key, bot_id, tools_env_enabled, route_kind
         FROM cadmus_chat_conversations WHERE bot_id = ?`,
				botId,
			)
			.toArray();
		return rows.map((row) => ({
			conversationId: Number(row.conversation_id),
			chatKey: row.chat_key,
			botId: row.bot_id,
			toolsEnvEnabled: row.tools_env_enabled !== 0,
			kind: (row.route_kind as ConversationRouteKind) || "direct",
		}));
	}

	getConversationRoute(conversationId: number): ConversationRoute | undefined {
		const rows = this.sql
			.exec<{
				conversation_id: number;
				chat_key: string;
				bot_id: string;
				tools_env_enabled: number;
				route_kind?: string | null;
			}>(
				`SELECT conversation_id, chat_key, bot_id, tools_env_enabled, route_kind
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
			kind: (row.route_kind as ConversationRouteKind) || "direct",
		};
	}

	recordConversationRoute(route: ConversationRoute): void {
		this.sql.exec(
			`INSERT INTO cadmus_chat_conversations (conversation_id, chat_key, bot_id, tools_env_enabled, route_kind)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         chat_key = excluded.chat_key,
         bot_id = excluded.bot_id,
         tools_env_enabled = excluded.tools_env_enabled,
         route_kind = excluded.route_kind`,
			route.conversationId,
			route.chatKey,
			route.botId,
			route.toolsEnvEnabled ? 1 : 0,
			route.kind ?? "direct",
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

	copyConversationRoute(
		parentId: number,
		childId: number,
		kind?: ConversationRouteKind,
	): void {
		this.sql.exec(
			`INSERT OR IGNORE INTO cadmus_chat_conversations (conversation_id, chat_key, bot_id, tools_env_enabled, route_kind)
       SELECT ?, chat_key, bot_id, tools_env_enabled, COALESCE(?, route_kind)
       FROM cadmus_chat_conversations
       WHERE conversation_id = ?`,
			childId,
			kind ?? null,
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

class SqliteTaskStore implements TaskStore {
	constructor(private readonly sql: SqlStorage) {}

	add(chatKey: string, title: string, details: string, now: number): ChatTask {
		const idxRow = this.sql
			.exec<{ next_task_idx: number | null }>(
				`SELECT next_task_idx FROM cadmus_chats WHERE key = ?`,
				chatKey,
			)
			.toArray()[0];
		const index = Number(idxRow?.next_task_idx ?? 1);
		this.sql.exec(
			`INSERT INTO cadmus_chat_tasks (chat_key, idx, title, details, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
			chatKey,
			index,
			title,
			details,
			now,
			now,
		);
		this.sql.exec(
			`UPDATE cadmus_chats SET next_task_idx = ? WHERE key = ?`,
			index + 1,
			chatKey,
		);
		return {
			index,
			title,
			details,
			status: "pending",
			createdAt: now,
			updatedAt: now,
		};
	}

	remove(chatKey: string, index: number): ChatTask | undefined {
		const existing = this.get(chatKey, index);
		if (!existing) return undefined;
		this.sql.exec(
			`DELETE FROM cadmus_chat_tasks WHERE chat_key = ? AND idx = ?`,
			chatKey,
			index,
		);
		return existing;
	}

	get(chatKey: string, index: number): ChatTask | undefined {
		const row = this.sql
			.exec<TaskRow>(
				`SELECT * FROM cadmus_chat_tasks WHERE chat_key = ? AND idx = ?`,
				chatKey,
				index,
			)
			.toArray()[0];
		return row ? this.mapTask(row) : undefined;
	}

	start(chatKey: string, index: number, now: number): ChatTask | undefined {
		const existing = this.get(chatKey, index);
		if (!existing) return undefined;
		this.sql.exec(
			`UPDATE cadmus_chat_tasks SET status = 'in_progress', updated_at = ? WHERE chat_key = ? AND idx = ?`,
			now,
			chatKey,
			index,
		);
		return { ...existing, status: "in_progress", updatedAt: now };
	}

	finish(
		chatKey: string,
		index: number,
		now: number,
		summary?: string,
	): ChatTask | undefined {
		const existing = this.get(chatKey, index);
		if (!existing) return undefined;
		this.sql.exec(
			`UPDATE cadmus_chat_tasks SET status = 'done', summary = ?, updated_at = ? WHERE chat_key = ? AND idx = ?`,
			summary ?? null,
			now,
			chatKey,
			index,
		);
		return {
			...existing,
			status: "done",
			updatedAt: now,
			...(summary ? { summary } : {}),
		};
	}

	list(chatKey: string): ChatTask[] {
		return this.sql
			.exec<TaskRow>(
				`SELECT * FROM cadmus_chat_tasks WHERE chat_key = ? ORDER BY idx ASC`,
				chatKey,
			)
			.toArray()
			.map((row) => this.mapTask(row));
	}

	clear(chatKey: string): void {
		this.sql.exec(`DELETE FROM cadmus_chat_tasks WHERE chat_key = ?`, chatKey);
		this.sql.exec(
			`UPDATE cadmus_chats SET next_task_idx = 1, loop_round = 0, loop_started_at = NULL,
         tasks_paused = 0, tasks_capped = 0, run_deadline = NULL, stuck_rounds = 0,
         continue_admitted_round = NULL
       WHERE key = ?`,
			chatKey,
		);
	}

	openCount(chatKey: string): number {
		const row = this.sql
			.exec<{ n: number }>(
				`SELECT COUNT(*) AS n FROM cadmus_chat_tasks WHERE chat_key = ? AND status IN ('pending','in_progress')`,
				chatKey,
			)
			.toArray()[0];
		return Number(row?.n ?? 0);
	}

	inProgress(chatKey: string): ChatTask | undefined {
		const row = this.sql
			.exec<TaskRow>(
				`SELECT * FROM cadmus_chat_tasks WHERE chat_key = ? AND status = 'in_progress' ORDER BY idx ASC LIMIT 1`,
				chatKey,
			)
			.toArray()[0];
		return row ? this.mapTask(row) : undefined;
	}

	lowestPending(chatKey: string): ChatTask | undefined {
		const row = this.sql
			.exec<TaskRow>(
				`SELECT * FROM cadmus_chat_tasks WHERE chat_key = ? AND status = 'pending' ORDER BY idx ASC LIMIT 1`,
				chatKey,
			)
			.toArray()[0];
		return row ? this.mapTask(row) : undefined;
	}

	getLoop(chatKey: string): TaskLoopState {
		const row = this.sql
			.exec<{
				loop_round: number | null;
				loop_started_at: number | null;
				tasks_paused: number | null;
				tasks_capped: number | null;
				run_deadline: number | null;
				stuck_rounds: number | null;
				continue_admitted_round: number | null;
			}>(
				`SELECT loop_round, loop_started_at, tasks_paused, tasks_capped, run_deadline, stuck_rounds, continue_admitted_round
         FROM cadmus_chats WHERE key = ?`,
				chatKey,
			)
			.toArray()[0];
		return {
			round: Number(row?.loop_round ?? 0),
			paused: row?.tasks_paused === 1,
			capped: row?.tasks_capped === 1,
			stuckRounds: Number(row?.stuck_rounds ?? 0),
			...(row?.loop_started_at != null
				? { startedAt: Number(row.loop_started_at) }
				: {}),
			...(row?.run_deadline != null
				? { runDeadline: Number(row.run_deadline) }
				: {}),
			...(row?.continue_admitted_round != null
				? { continueAdmittedRound: Number(row.continue_admitted_round) }
				: {}),
		};
	}

	setLoop(chatKey: string, loop: TaskLoopState): void {
		this.sql.exec(
			`UPDATE cadmus_chats SET loop_round = ?, loop_started_at = ?, tasks_paused = ?, tasks_capped = ?,
         run_deadline = ?, stuck_rounds = ?, continue_admitted_round = ?
       WHERE key = ?`,
			loop.round,
			loop.startedAt ?? null,
			loop.paused ? 1 : 0,
			loop.capped ? 1 : 0,
			loop.runDeadline ?? null,
			loop.stuckRounds,
			loop.continueAdmittedRound ?? null,
			chatKey,
		);
	}

	listRunDeadlines(): { chatKey: string; runDeadline: number }[] {
		return this.sql
			.exec<{ key: string; run_deadline: number }>(
				`SELECT key, run_deadline FROM cadmus_chats
         WHERE run_deadline IS NOT NULL AND run_deadline > 0
           AND tasks_capped = 0 AND tasks_paused = 0`,
			)
			.toArray()
			.map((row) => ({
				chatKey: row.key,
				runDeadline: Number(row.run_deadline),
			}));
	}

	private mapTask(row: TaskRow): ChatTask {
		const rec: ChatTask = {
			index: Number(row.idx),
			title: row.title,
			details: row.details,
			status: row.status as ChatTask["status"],
			createdAt: Number(row.created_at),
			updatedAt: Number(row.updated_at),
		};
		if (row.summary) rec.summary = row.summary;
		return rec;
	}
}

type TaskRow = {
	chat_key: string;
	idx: number;
	title: string;
	details: string;
	status: string;
	summary: string | null;
	created_at: number;
	updated_at: number;
};

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

class SqliteGroupStore implements GroupStore {
	constructor(private readonly sql: SqlStorage) {}

	getById(id: string): GroupChatRecord | undefined {
		return this.map(
			this.sql
				.exec<GroupRow>(`SELECT * FROM cadmus_group_chats WHERE id = ?`, id)
				.toArray()[0],
		);
	}

	getByTaskId(taskId: string): GroupChatRecord | undefined {
		return this.map(
			this.sql
				.exec<GroupRow>(
					`SELECT * FROM cadmus_group_chats WHERE task_id = ?`,
					taskId,
				)
				.toArray()[0],
		);
	}

	findByMemberKey(
		chatKey: string,
	):
		| { group: GroupChatRecord; botId: string; role: "caller" | "member" }
		| undefined {
		const row = this.sql
			.exec<{ group_id: string; bot_id: string; role: string }>(
				`SELECT group_id, bot_id, role FROM cadmus_group_members WHERE chat_key = ?`,
				chatKey,
			)
			.toArray()[0];
		if (!row) return undefined;
		const group = this.getById(row.group_id);
		if (!group) return undefined;
		return {
			group,
			botId: row.bot_id,
			role: row.role === "caller" ? "caller" : "member",
		};
	}

	insert(group: GroupChatRecord): void {
		this.sql.exec(
			`INSERT INTO cadmus_group_chats (
        id, topic, members_json, creator_bot_id, root_request_id, human_read_only,
        hop_chain_json, turn_count, status, mode, origin_chat_key, task_id, opening_text,
        end_response, created_at, updated_at, overall_deadline, reply_deadline,
        delivered_json, tools_read_only
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			group.id,
			group.topic,
			JSON.stringify(group.members),
			group.creatorBotId,
			group.rootRequestId,
			JSON.stringify(group.hopChain),
			group.turnCount,
			group.status,
			group.mode,
			group.originChatKey,
			group.taskId,
			group.openingText,
			group.endResponse ?? null,
			group.createdAt,
			group.updatedAt,
			group.overallDeadline,
			group.replyDeadline ?? null,
			JSON.stringify(group.delivered),
			group.toolsReadOnly === true ? 1 : 0,
		);
	}

	save(group: GroupChatRecord): void {
		this.sql.exec(
			`UPDATE cadmus_group_chats SET
        turn_count = ?, status = ?, end_response = ?,
        updated_at = ?, reply_deadline = ?, delivered_json = ?, hop_chain_json = ?
       WHERE id = ?`,
			group.turnCount,
			group.status,
			group.endResponse ?? null,
			group.updatedAt,
			group.replyDeadline ?? null,
			JSON.stringify(group.delivered),
			JSON.stringify(group.hopChain),
			group.id,
		);
	}

	list(): GroupChatRecord[] {
		return this.sql
			.exec<GroupRow>(
				`SELECT * FROM cadmus_group_chats ORDER BY created_at ASC, id ASC`,
			)
			.toArray()
			.flatMap((row) => {
				const mapped = this.map(row);
				return mapped ? [mapped] : [];
			});
	}

	listOpen(): GroupChatRecord[] {
		return this.list().filter((group) => group.status === "open");
	}

	appendMessage(
		groupId: string,
		fromBotId: string,
		text: string,
		at: number,
	): GroupMessage {
		const next = this.sql
			.exec<{ seq: number }>(
				`SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM cadmus_group_messages WHERE group_id = ?`,
				groupId,
			)
			.toArray()[0];
		const seq = Number(next?.seq ?? 1);
		this.sql.exec(
			`INSERT INTO cadmus_group_messages (group_id, seq, from_bot_id, text, at_ms)
       VALUES (?, ?, ?, ?, ?)`,
			groupId,
			seq,
			fromBotId,
			text,
			at,
		);
		return { seq, fromBotId, text, at };
	}

	listMessages(groupId: string): GroupMessage[] {
		return this.sql
			.exec<{ seq: number; from_bot_id: string; text: string; at_ms: number }>(
				`SELECT seq, from_bot_id, text, at_ms FROM cadmus_group_messages
         WHERE group_id = ? ORDER BY seq ASC`,
				groupId,
			)
			.toArray()
			.map((row) => ({
				seq: Number(row.seq),
				fromBotId: row.from_bot_id,
				text: row.text,
				at: Number(row.at_ms),
			}));
	}

	peerActions(rootRequestId: string): number {
		const row = this.sql
			.exec<{ used: number }>(
				`SELECT used FROM cadmus_peer_actions WHERE root_request_id = ?`,
				rootRequestId,
			)
			.toArray()[0];
		return row ? Number(row.used) : 0;
	}

	setPeerActions(rootRequestId: string, used: number): void {
		this.sql.exec(
			`INSERT INTO cadmus_peer_actions (root_request_id, used) VALUES (?, ?)
       ON CONFLICT(root_request_id) DO UPDATE SET used = excluded.used`,
			rootRequestId,
			used,
		);
	}

	setHopContext(rootRequestId: string, chain: readonly string[]): void {
		this.sql.exec(
			`INSERT INTO cadmus_hop_context (root_request_id, chain_json) VALUES (?, ?)
       ON CONFLICT(root_request_id) DO UPDATE SET chain_json = excluded.chain_json`,
			rootRequestId,
			JSON.stringify(chain),
		);
	}

	hopContext(rootRequestId: string): string[] | undefined {
		const row = this.sql
			.exec<{ chain_json: string }>(
				`SELECT chain_json FROM cadmus_hop_context WHERE root_request_id = ?`,
				rootRequestId,
			)
			.toArray()[0];
		if (!row) return undefined;
		return JSON.parse(row.chain_json) as string[];
	}

	wakeHold(id: string): number | undefined {
		const row = this.sql
			.exec<{ wake_not_before: number | null }>(
				`SELECT wake_not_before FROM cadmus_group_chats WHERE id = ?`,
				id,
			)
			.toArray()[0];
		if (!row || row.wake_not_before == null) return undefined;
		return Number(row.wake_not_before);
	}

	wakeAdmitted(id: string): boolean {
		const row = this.sql
			.exec<{ wake_admitted: number }>(
				`SELECT wake_admitted FROM cadmus_group_chats WHERE id = ?`,
				id,
			)
			.toArray()[0];
		return Number(row?.wake_admitted ?? 0) === 1;
	}

	markWakeAdmitted(id: string): void {
		this.sql.exec(
			`UPDATE cadmus_group_chats SET wake_admitted = 1 WHERE id = ?`,
			id,
		);
	}

	delete(id: string): void {
		this.sql.exec(`DELETE FROM cadmus_group_messages WHERE group_id = ?`, id);
		this.sql.exec(`DELETE FROM cadmus_group_members WHERE group_id = ?`, id);
		this.sql.exec(`DELETE FROM cadmus_group_chats WHERE id = ?`, id);
	}

	memberChatKeys(groupId: string): string[] {
		return this.sql
			.exec<{ chat_key: string }>(
				`SELECT chat_key FROM cadmus_group_members WHERE group_id = ?`,
				groupId,
			)
			.toArray()
			.map((row) => row.chat_key);
	}

	bindMember(
		groupId: string,
		botId: string,
		chatKey: string,
		role: "caller" | "member",
	): void {
		this.sql.exec(
			`INSERT INTO cadmus_group_members (group_id, bot_id, chat_key, role)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(group_id, bot_id) DO UPDATE SET chat_key = excluded.chat_key, role = excluded.role`,
			groupId,
			botId,
			chatKey,
			role,
		);
	}

	private map(row: GroupRow | undefined): GroupChatRecord | undefined {
		if (!row) return undefined;
		const record: GroupChatRecord = {
			id: row.id,
			topic: row.topic,
			members: JSON.parse(row.members_json) as string[],
			creatorBotId: row.creator_bot_id,
			rootRequestId: row.root_request_id,
			humanReadOnly: true,
			...(Number(row.tools_read_only) === 1 ? { toolsReadOnly: true } : {}),
			hopChain: JSON.parse(row.hop_chain_json) as string[],
			turnCount: Number(row.turn_count),
			status: row.status as GroupChatRecord["status"],
			mode: row.mode === "forget" ? "forget" : "wait",
			originChatKey: row.origin_chat_key,
			taskId: row.task_id,
			openingText: row.opening_text,
			createdAt: Number(row.created_at),
			updatedAt: Number(row.updated_at),
			overallDeadline: Number(row.overall_deadline),
			delivered: JSON.parse(row.delivered_json) as Record<string, number>,
		};
		if (row.end_response != null) record.endResponse = row.end_response;
		if (row.reply_deadline != null) {
			record.replyDeadline = Number(row.reply_deadline);
		}
		return record;
	}
}

type GroupRow = {
	id: string;
	topic: string;
	members_json: string;
	creator_bot_id: string;
	root_request_id: string;
	hop_chain_json: string;
	turn_count: number;
	status: string;
	mode?: string | null;
	origin_chat_key: string;
	task_id: string;
	opening_text: string;
	end_response: string | null;
	created_at: number;
	updated_at: number;
	overall_deadline: number;
	reply_deadline: number | null;
	delivered_json: string;
	tools_read_only?: number | null;
};

export class SqliteFamilyStore implements FamilyStore {
	readonly bots: BotStore;
	readonly files: BotFileStore;
	readonly chats: ChatStore;
	readonly schedules: ScheduleStore;
	readonly harvest: HarvestStore;
	readonly groups: GroupStore;
	readonly tasks: TaskStore;
	private initialized = false;

	constructor(private readonly sql: SqlStorage) {
		this.bots = new SqliteBotStore(sql);
		this.files = new SqliteBotFileStore(sql);
		this.chats = new SqliteChatStore(sql);
		this.schedules = new SqliteScheduleStore(sql);
		this.harvest = new SqliteHarvestStore(sql);
		this.groups = new SqliteGroupStore(sql);
		this.tasks = new SqliteTaskStore(sql);
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
        metadata_json TEXT,
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

      CREATE TABLE IF NOT EXISTS cadmus_bot_skills (
        bot_id TEXT NOT NULL REFERENCES cadmus_bots(id) ON DELETE CASCADE,
        slug TEXT NOT NULL,
        description TEXT NOT NULL,
        category TEXT,
        version INTEGER NOT NULL,
        body TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (bot_id, slug)
      );

      CREATE INDEX IF NOT EXISTS idx_cadmus_bot_skills_cat
        ON cadmus_bot_skills(bot_id, category);

      CREATE TABLE IF NOT EXISTS cadmus_family_skills (
        slug TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        category TEXT,
        version INTEGER NOT NULL,
        body TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cadmus_family_skills_cat
        ON cadmus_family_skills(category);

      CREATE TABLE IF NOT EXISTS cadmus_chats (
        key TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES cadmus_bots(id) ON DELETE CASCADE,
        conversation_id INTEGER NOT NULL,
        title TEXT,
        thinking TEXT,
        closed INTEGER NOT NULL DEFAULT 0,
        tools_env_json TEXT,
        created_at INTEGER NOT NULL,
        harvest_enabled INTEGER NOT NULL DEFAULT 1,
        kind TEXT NOT NULL DEFAULT 'direct',
        deleted_at INTEGER,
        origin_chat_key TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_cadmus_chats_bot
        ON cadmus_chats(bot_id);

      CREATE INDEX IF NOT EXISTS idx_cadmus_chats_conv
        ON cadmus_chats(conversation_id);

      CREATE TABLE IF NOT EXISTS cadmus_chat_conversations (
        conversation_id INTEGER PRIMARY KEY,
        chat_key TEXT NOT NULL REFERENCES cadmus_chats(key) ON DELETE CASCADE,
        bot_id TEXT NOT NULL REFERENCES cadmus_bots(id) ON DELETE CASCADE,
        tools_env_enabled INTEGER NOT NULL DEFAULT 1,
        route_kind TEXT NOT NULL DEFAULT 'direct'
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

      CREATE TABLE IF NOT EXISTS cadmus_entry_authors (
        chat_key TEXT NOT NULL,
        entry_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        PRIMARY KEY (chat_key, entry_id)
      );

      CREATE TABLE IF NOT EXISTS cadmus_turn_roots (
        chat_key TEXT PRIMARY KEY,
        root_request_id TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cadmus_group_chats (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        members_json TEXT NOT NULL,
        creator_bot_id TEXT NOT NULL,
        root_request_id TEXT NOT NULL,
        human_read_only INTEGER NOT NULL DEFAULT 1,
        hop_chain_json TEXT NOT NULL,
        turn_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'wait',
        origin_chat_key TEXT NOT NULL,
        task_id TEXT NOT NULL UNIQUE,
        opening_text TEXT NOT NULL,
        end_response TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        overall_deadline INTEGER NOT NULL,
        reply_deadline INTEGER,
        delivered_json TEXT NOT NULL,
        wake_not_before INTEGER,
        wake_admitted INTEGER NOT NULL DEFAULT 0,
        tools_read_only INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS cadmus_group_members (
        group_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        chat_key TEXT NOT NULL,
        role TEXT NOT NULL,
        PRIMARY KEY (group_id, bot_id)
      );

      CREATE INDEX IF NOT EXISTS idx_cadmus_group_members_chat
        ON cadmus_group_members(chat_key);

      CREATE TABLE IF NOT EXISTS cadmus_group_messages (
        group_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        from_bot_id TEXT NOT NULL,
        text TEXT NOT NULL,
        at_ms INTEGER NOT NULL,
        PRIMARY KEY (group_id, seq)
      );

      CREATE TABLE IF NOT EXISTS cadmus_peer_actions (
        root_request_id TEXT PRIMARY KEY,
        used INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cadmus_hop_context (
        root_request_id TEXT PRIMARY KEY,
        chain_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cadmus_chat_tasks (
        chat_key TEXT NOT NULL REFERENCES cadmus_chats(key) ON DELETE CASCADE,
        idx INTEGER NOT NULL,
        title TEXT NOT NULL,
        details TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','in_progress','done')),
        summary TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (chat_key, idx)
      );
    `);
		ensureBotColumn(this.sql, "metadata_json", "TEXT");
		ensureChatColumn(this.sql, "harvest_enabled", "INTEGER NOT NULL DEFAULT 1");
		ensureChatColumn(this.sql, "kind", "TEXT NOT NULL DEFAULT 'direct'");
		ensureChatColumn(this.sql, "deleted_at", "INTEGER");
		ensureChatColumn(this.sql, "origin_chat_key", "TEXT");
		this.sql.exec(
			"CREATE INDEX IF NOT EXISTS idx_cadmus_chats_origin ON cadmus_chats(origin_chat_key);",
		);
		this.sql.exec(
			"CREATE INDEX IF NOT EXISTS idx_cadmus_chats_deleted ON cadmus_chats(deleted_at);",
		);
		ensureChatConversationColumn(
			this.sql,
			"route_kind",
			"TEXT NOT NULL DEFAULT 'direct'",
		);
		this.sql.exec(
			"CREATE INDEX IF NOT EXISTS idx_cadmus_chat_conversations_bot ON cadmus_chat_conversations(bot_id);",
		);
		ensureChatColumn(this.sql, "next_task_idx", "INTEGER NOT NULL DEFAULT 1");
		ensureChatColumn(this.sql, "loop_round", "INTEGER NOT NULL DEFAULT 0");
		ensureChatColumn(this.sql, "loop_started_at", "INTEGER");
		ensureChatColumn(this.sql, "tasks_paused", "INTEGER NOT NULL DEFAULT 0");
		ensureChatColumn(this.sql, "tasks_capped", "INTEGER NOT NULL DEFAULT 0");
		ensureChatColumn(this.sql, "run_deadline", "INTEGER");
		ensureChatColumn(this.sql, "stuck_rounds", "INTEGER NOT NULL DEFAULT 0");
		ensureChatColumn(this.sql, "continue_admitted_round", "INTEGER");
		ensureChatColumn(this.sql, "deadlines_json", "TEXT");
		dropChatColumn(this.sql, "continue_hold");
		this.sql.exec(
			"CREATE INDEX IF NOT EXISTS idx_cadmus_chats_kind ON cadmus_chats(kind);",
		);
		dropChatColumn(this.sql, "listed");
		ensureGroupColumn(this.sql, "mode", "TEXT NOT NULL DEFAULT 'wait'");
		ensureGroupColumn(this.sql, "wake_not_before", "INTEGER");
		ensureGroupColumn(this.sql, "wake_admitted", "INTEGER NOT NULL DEFAULT 0");
		ensureGroupColumn(
			this.sql,
			"tools_read_only",
			"INTEGER NOT NULL DEFAULT 0",
		);
		dropGroupColumn(this.sql, "replay_armed");

		this.initialized = true;
	}
}

function dropGroupColumn(sql: SqlStorage, name: string): void {
	const cols = sql
		.exec<{ name: string }>(`PRAGMA table_info(cadmus_group_chats)`)
		.toArray();
	if (!cols.some((col) => col.name === name)) return;
	sql.exec(`ALTER TABLE cadmus_group_chats DROP COLUMN ${name}`);
}

function ensureGroupColumn(sql: SqlStorage, name: string, ddl: string): void {
	const cols = sql
		.exec<{ name: string }>(`PRAGMA table_info(cadmus_group_chats)`)
		.toArray();
	if (cols.some((col) => col.name === name)) return;
	sql.exec(`ALTER TABLE cadmus_group_chats ADD COLUMN ${name} ${ddl}`);
}

function dropChatColumn(sql: SqlStorage, name: string): void {
	const cols = sql
		.exec<{ name: string }>(`PRAGMA table_info(cadmus_chats)`)
		.toArray();
	if (!cols.some((col) => col.name === name)) return;
	sql.exec(`ALTER TABLE cadmus_chats DROP COLUMN ${name}`);
}

function ensureChatConversationColumn(
	sql: SqlStorage,
	name: string,
	ddl: string,
): void {
	const cols = sql
		.exec<{ name: string }>(`PRAGMA table_info(cadmus_chat_conversations)`)
		.toArray();
	if (cols.some((col) => col.name === name)) return;
	sql.exec(`ALTER TABLE cadmus_chat_conversations ADD COLUMN ${name} ${ddl}`);
}

function ensureChatColumn(sql: SqlStorage, name: string, ddl: string): void {
	const cols = sql
		.exec<{ name: string }>(`PRAGMA table_info(cadmus_chats)`)
		.toArray();
	if (cols.some((col) => col.name === name)) return;
	sql.exec(`ALTER TABLE cadmus_chats ADD COLUMN ${name} ${ddl}`);
}

function ensureBotColumn(sql: SqlStorage, name: string, ddl: string): void {
	const cols = sql
		.exec<{ name: string }>(`PRAGMA table_info(cadmus_bots)`)
		.toArray();
	if (cols.some((col) => col.name === name)) return;
	sql.exec(`ALTER TABLE cadmus_bots ADD COLUMN ${name} ${ddl}`);
}
