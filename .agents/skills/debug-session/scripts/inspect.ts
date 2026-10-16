/**
 * Read-only dump of a pi-bot home. Does not take owner.lock.
 *
 *   bun .agents/skills/debug-session/scripts/inspect.ts [--home <dir>] [selector]
 *
 * selector is a bot id, a chat-key substring, or a conversation id.
 * Default home is ./data. A selector also dumps harvest forks for that chat.
 */

import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { apply } from "@earendil-works/chord/delta";
import { dumpHarvest } from "./harvest.ts";

type Doc = { id: number; kind: string; owner: number; value: unknown };

const args = process.argv.slice(2);
let home = resolve("data");
const rest: string[] = [];
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--home") home = resolve(args[++i] ?? "");
	else rest.push(args[i] ?? "");
}
const selector = rest.join(" ").trim();

const db = new Database(join(home, "durable.sqlite"), { readonly: true });

function materialize(id: number): unknown {
	const base = db
		.query(
			`SELECT seq, version, content FROM document_revisions
			 WHERE document_id = ? AND kind = 'base' ORDER BY seq DESC LIMIT 1`,
		)
		.get(id) as { seq: number; version: number; content: string } | null;
	if (!base) return undefined;
	let value: unknown = JSON.parse(base.content);
	const tail = db
		.query(
			`SELECT kind, version, content FROM document_revisions
			 WHERE document_id = ? AND seq > ? ORDER BY seq`,
		)
		.all(id, base.seq) as { kind: string; version: number; content: string }[];
	for (const rev of tail) {
		if (rev.kind !== "delta" || rev.version !== base.version) break;
		value = apply(value, JSON.parse(rev.content));
	}
	return value;
}

function docs(kind: string): Doc[] {
	const rows = db
		.query(
			`SELECT id, kind, owner_id AS owner FROM documents
			 WHERE kind = ? AND retired_at IS NULL`,
		)
		.all(JSON.stringify(kind)) as { id: number; kind: string; owner: number }[];
	return rows.map((row) => ({ ...row, value: materialize(row.id) }));
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const p = part as Record<string, unknown>;
			if (typeof p.text === "string") return p.text;
			if (typeof p.name === "string") return `${p.type ?? "tool"} ${p.name}`;
			if (typeof p.type === "string") return p.type;
			return "";
		})
		.filter(Boolean)
		.join(" ");
}

type Chat = {
	key: string;
	botId: string;
	conversationId: number;
	title?: string;
	userId?: string;
};

const chatsDoc = docs("pi-bot.telegram.chats")[0]?.value as
	| { items?: Chat[]; closed?: string[] }
	| undefined;
const chats = chatsDoc?.items ?? [];
const closed = new Set(chatsDoc?.closed ?? []);

const bots = docs("pi-bot.bots")[0]?.value as
	| { items?: { id: string; name?: string; model?: string }[] }
	| undefined;

function matches(chat: Chat): boolean {
	if (!selector) return true;
	if (selector === String(chat.conversationId)) return true;
	if (chat.botId === selector || chat.key === selector) return true;
	return (
		chat.key.includes(selector) || (chat.title?.includes(selector) ?? false)
	);
}

const picked = chats.filter(matches);
console.log(`home ${home}`);
console.log(
	`bots ${(bots?.items ?? []).map((b) => b.id).join(", ") || "(none)"}`,
);
console.log(
	`chats ${picked.length}/${chats.length} live, closed keys ${closed.size}`,
);

if (!selector) {
	for (const chat of chats) {
		console.log(
			`${closed.has(chat.key) ? "closed" : "live"}\t${chat.conversationId}\t${chat.key}\t${chat.title ?? ""}`,
		);
	}
	process.exit(0);
}

for (const chat of picked) {
	console.log(
		`\n# ${chat.key} conversation ${chat.conversationId}${closed.has(chat.key) ? " closed" : ""}`,
	);
	const entries = db
		.query(
			`SELECT id, record FROM entries WHERE conversation_id = ? ORDER BY id DESC LIMIT 40`,
		)
		.all(chat.conversationId) as { id: number; record: string }[];
	for (const row of entries.reverse()) {
		const record = JSON.parse(row.record) as {
			model?: { role?: string; content?: unknown }[];
		};
		const line = (record.model ?? [])
			.map(
				(m) =>
					`${m.role ?? "?"}: ${textOf(m.content).replaceAll("\n", " ").slice(0, 180)}`,
			)
			.join(" || ");
		console.log(`${row.id}\t${line}`);
	}
	const tasks = db
		.query(
			`SELECT id, kind, status, abort_requested FROM tasks
			 WHERE conversation_id = ? AND status != 'terminal'`,
		)
		.all(chat.conversationId) as {
		id: number;
		kind: string;
		status: string;
		abort_requested: number;
	}[];
	console.log(`open tasks ${tasks.length}`);
	for (const task of tasks)
		console.log(
			`  task ${task.id} ${task.kind} ${task.status} abort=${task.abort_requested}`,
		);
	const subs = db
		.query(
			`SELECT id, status, request_id FROM submissions
			 WHERE conversation_id = ? AND status != 'done'`,
		)
		.all(chat.conversationId) as {
		id: number;
		status: string;
		request_id: string | null;
	}[];
	console.log(`open submissions ${subs.length}`);
	for (const sub of subs)
		console.log(`  sub ${sub.id} ${sub.status} ${sub.request_id ?? ""}`);
	const deliveries = docs("pi-bot.telegram.deliveries").find(
		(d) => d.owner === chat.conversationId,
	);
	console.log(`deliveries ${JSON.stringify(deliveries?.value ?? null)}`);
	dumpHarvest(db, chat, join(home, "schedules.sqlite"));
}

const schedPath = join(home, "schedules.sqlite");
try {
	const sched = new Database(schedPath, { readonly: true });
	const rows = sched
		.query(
			`SELECT id, bot_id, kind, next_run, enabled, substr(text,1,80) AS text, target_json
			 FROM schedules ORDER BY next_run`,
		)
		.all() as Record<string, unknown>[];
	const shown = selector
		? rows.filter(
				(row) =>
					JSON.stringify(row).includes(selector) ||
					picked.some((c) => JSON.stringify(row).includes(c.key)),
			)
		: rows;
	console.log(`\nschedules ${shown.length}`);
	for (const row of shown) console.log(JSON.stringify(row));
} catch (error) {
	console.log(
		`schedules unreadable: ${error instanceof Error ? error.message : error}`,
	);
}
