/**
 * Read-only harvest dump for one chat. Used by inspect.ts and:
 *
 *   bun .agents/skills/debug-session/scripts/harvest.ts [--home <dir>] <selector>
 */

import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { apply } from "@earendil-works/chord/delta";

export type Chat = {
	key: string;
	botId: string;
	conversationId: number;
	title?: string;
};

type HarvestFile = { path: string; diff: string };
type HarvestNote = {
	chatKey: string;
	at: number;
	files: HarvestFile[];
	when: number;
};
type HarvestPending = {
	at: number;
	before: Record<string, string>;
	childId?: number;
};
type HarvestNotesState = {
	notes?: HarvestNote[];
	completed?: Record<string, number>;
	pending?: Record<string, HarvestPending>;
};

function materialize(db: Database, id: number): unknown {
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

function harvestNotes(db: Database): HarvestNotesState | undefined {
	const row = db
		.query(
			`SELECT id FROM documents
			 WHERE kind = ? AND retired_at IS NULL LIMIT 1`,
		)
		.get(JSON.stringify("pi-bot.harvest-notes")) as { id: number } | null;
	if (!row) return undefined;
	return materialize(db, row.id) as HarvestNotesState;
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

function unwrapId(value: string | null | undefined): string {
	if (!value) return "";
	if (value.startsWith('"')) {
		try {
			const parsed: unknown = JSON.parse(value);
			return typeof parsed === "string" ? parsed : value;
		} catch {
			return value;
		}
	}
	return value;
}

function toolNames(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const names: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const p = part as Record<string, unknown>;
		if (typeof p.name !== "string") continue;
		const type = typeof p.type === "string" ? p.type : "";
		if (
			type.includes("tool") ||
			type.includes("function") ||
			type.includes("Call")
		)
			names.push(p.name);
	}
	return names;
}

type EntryRow = {
	id: number;
	kind?: string;
	role?: string;
	text: string;
	tools: string[];
	stop?: string;
	usage?: unknown;
	toolsRemoved?: unknown;
};

function parseEntry(recordJson: string, id: number): EntryRow {
	const record = JSON.parse(recordJson) as {
		kind?: string;
		model?: {
			role?: string;
			content?: unknown;
			stopReason?: string;
			usage?: unknown;
			toolsRemoved?: unknown;
		}[];
	};
	const model = record.model?.[0];
	return {
		id,
		kind: record.kind,
		role: model?.role,
		text: textOf(model?.content).replaceAll("\n", " ").slice(0, 280),
		tools: toolNames(model?.content),
		stop: model?.stopReason,
		usage: model?.usage,
		toolsRemoved: model?.toolsRemoved,
	};
}

export function dumpHarvest(db: Database, chat: Chat, schedPath: string): void {
	const state = harvestNotes(db) ?? {};
	const notes = (state.notes ?? []).filter((n) => n.chatKey === chat.key);
	const completedAt = state.completed?.[chat.key];
	const pending = state.pending?.[chat.key];

	console.log(`\n# harvest ${chat.key}`);
	console.log(
		`completed at ${completedAt ?? "(none)"}  pending ${pending ? `at=${pending.at} child=${pending.childId ?? "(no child)"}` : "(none)"}`,
	);
	console.log(`knowledge notes ${notes.length}`);
	for (const note of notes) {
		console.log(
			`  note at=${note.at} when=${note.when} files=${note.files.map((f) => f.path).join(",") || "(empty)"}`,
		);
		for (const file of note.files) {
			const preview = file.diff.replaceAll("\n", " ").slice(0, 200);
			console.log(`    ${file.path} ${preview}`);
		}
	}

	const prefix = `sched:harvest:${chat.key}:`;
	let fires: string[] = [];
	try {
		const sched = new Database(schedPath, { readonly: true });
		fires = (
			sched.query(`SELECT request_id FROM fires`).all() as {
				request_id: string;
			}[]
		)
			.map((r) => unwrapId(r.request_id))
			.filter((id) => id.startsWith(prefix) || id.includes(chat.key));
		const armed = sched
			.query(
				`SELECT id, kind, next_run, enabled, target_json FROM schedules WHERE id = ?`,
			)
			.get(`harvest:${chat.key}`) as Record<string, unknown> | null;
		console.log(`armed ${armed ? JSON.stringify(armed) : "(none)"}`);
		console.log(`fires ${fires.length}`);
		for (const id of fires) console.log(`  ${id}`);
	} catch (error) {
		console.log(
			`schedules unreadable: ${error instanceof Error ? error.message : error}`,
		);
	}

	const children = db
		.query(
			`SELECT id, record FROM conversations
			 WHERE json_extract(record, '$.parent.conversationId') = ?`,
		)
		.all(chat.conversationId) as { id: number; record: string }[];
	console.log(`forks ${children.length}`);
	for (const child of children) {
		const rec = JSON.parse(child.record) as {
			id: number;
			parent?: { conversationId: number; at?: number };
		};
		const at = rec.parent?.at;
		const subs = db
			.query(
				`SELECT id, status, request_id, record FROM submissions
				 WHERE conversation_id = ?`,
			)
			.all(child.id) as {
			id: number;
			status: string;
			request_id: string | null;
			record: string;
		}[];
		const harvestSubs = subs.filter((s) => {
			const fromCol = unwrapId(s.request_id);
			const fromRecord = (JSON.parse(s.record) as { requestId?: string })
				.requestId;
			const id = fromCol || fromRecord || "";
			s.request_id = id;
			return id.startsWith("sched:harvest:");
		});
		const tasks = db
			.query(
				`SELECT id, kind, status, abort_requested, record FROM tasks
				 WHERE conversation_id = ?`,
			)
			.all(child.id) as {
			id: number;
			kind: string;
			status: string;
			abort_requested: number;
			record: string;
		}[];
		const entries = db
			.query(
				`SELECT id, record FROM entries WHERE conversation_id = ? ORDER BY id`,
			)
			.all(child.id) as { id: number; record: string }[];
		const parsed = entries.map((e) => parseEntry(e.record, e.id));
		const assistant = [...parsed].reverse().find((e) => e.role === "assistant");
		const called = parsed.flatMap((e) => e.tools);
		const toolResults = parsed.filter(
			(e) =>
				e.kind === "pi.toolResult" ||
				e.role === "tool" ||
				e.role === "toolResult",
		);

		console.log(
			`  fork ${child.id} at=${at ?? "?"} subs=${harvestSubs.map((s) => `${s.id}:${s.status}:${s.request_id}`).join(" ") || "(none)"}`,
		);
		for (const task of tasks) {
			const record = JSON.parse(task.record) as {
				state?: { outcome?: { status?: string; result?: unknown } };
			};
			const outcome = record.state?.outcome;
			console.log(
				`    task ${task.id} ${task.kind} ${task.status} abort=${task.abort_requested} outcome=${outcome?.status ?? "?"} ${JSON.stringify(outcome?.result ?? {})}`,
			);
		}
		const removed = parsed.find((e) => e.toolsRemoved)?.toolsRemoved;
		if (removed) console.log(`    toolsRemoved ${JSON.stringify(removed)}`);
		console.log(
			`    tools called ${called.length ? called.join(",") : "(none)"}`,
		);
		for (const result of toolResults)
			console.log(`    toolResult ${result.id} ${result.text}`);
		if (assistant) {
			console.log(
				`    assistant ${assistant.id} stop=${assistant.stop ?? "?"} usage=${JSON.stringify(assistant.usage ?? null)}`,
			);
			console.log(`    ${assistant.text}`);
		} else console.log("    assistant (none)");
	}
	if (children.length === 0 && fires.length === 0 && completedAt === undefined)
		console.log(
			"  no harvest fork, fire, or completed mark — harvest did not run for this chat",
		);
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	let home = resolve("data");
	const rest: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--home") home = resolve(args[++i] ?? "");
		else rest.push(args[i] ?? "");
	}
	const selector = rest.join(" ").trim();
	if (!selector) {
		console.error("usage: harvest.ts [--home <dir>] <selector>");
		process.exit(1);
	}
	const db = new Database(join(home, "durable.sqlite"), { readonly: true });
	const chatsRow = db
		.query(
			`SELECT id FROM documents WHERE kind = ? AND retired_at IS NULL LIMIT 1`,
		)
		.get(JSON.stringify("pi-bot.telegram.chats")) as { id: number } | null;
	const chatsDoc = chatsRow
		? (materialize(db, chatsRow.id) as { items?: Chat[] })
		: undefined;
	const chats = (chatsDoc?.items ?? []).filter(
		(chat) =>
			selector === String(chat.conversationId) ||
			chat.botId === selector ||
			chat.key === selector ||
			chat.key.includes(selector) ||
			(chat.title?.includes(selector) ?? false),
	);
	if (chats.length === 0) {
		console.log(`no chat matched ${selector}`);
		process.exit(1);
	}
	for (const chat of chats)
		dumpHarvest(db, chat, join(home, "schedules.sqlite"));
}
