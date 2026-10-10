import { useState } from "preact/hooks";
import {
	deleteSchedule,
	loadSchedules,
	runSchedule,
	saveSchedule,
} from "./client.ts";
import { ConfirmDialog } from "./confirm.tsx";
import {
	banner,
	chats,
	type ScheduleRow,
	scheduleId,
	schedules,
	showList,
} from "./state.ts";

type Draft = {
	id?: string;
	text: string;
	kind: "cron" | "when";
	cron: string;
	when: string;
	mode: "chat" | "new-chat" | "fork";
	chatId: string;
};

function selected(): Draft {
	const row = schedules.value.find((item) => item.id === scheduleId.value);
	if (!row) {
		return {
			text: "",
			kind: "cron",
			cron: "0 8 * * *",
			when: "",
			mode: "new-chat",
			chatId: chats.value[0]?.key ?? "",
		};
	}
	return {
		id: row.id,
		text: row.text,
		kind: row.kind,
		cron: row.kind === "cron" ? row.cron : "0 8 * * *",
		when: row.kind === "when" ? toLocal(row.when) : "",
		mode: row.target.mode,
		chatId: row.target.chatId ?? chats.value[0]?.key ?? "",
	};
}

function pickSchedule(id: string | null): void {
	scheduleId.value = id;
	showList.value = false;
}

export function ScheduleList() {
	const count = schedules.value.length;
	return (
		<div class="list">
			<button
				type="button"
				class="btn ghost"
				onClick={() => pickSchedule(null)}
			>
				New schedule
			</button>
			{schedules.value.map((row) => (
				<button
					type="button"
					key={row.id}
					class={`c ${row.id === scheduleId.value ? "sel" : ""}`}
					onClick={() => pickSchedule(row.id)}
				>
					<div class="t">
						{row.kind === "cron" ? "⏱" : "⏰"} {row.text.slice(0, 42)}
					</div>
					<div class="key">{targetLabel(row)}</div>
					<div class="p">
						{row.kind === "cron" ? `cron ${row.cron}` : "when · once"}
						{row.nextRun
							? ` · next ${new Date(row.nextRun).toLocaleString()}`
							: ""}
					</div>
				</button>
			))}
			{count === 0 ? <p class="mu">No schedules yet.</p> : null}
		</div>
	);
}

export function Schedules() {
	const draft = selected();
	return (
		<main class="main">
			<div class="hd">
				<button
					type="button"
					class="back"
					title="Schedules"
					onClick={() => (showList.value = true)}
				>
					‹
				</button>
				<div>
					<div class="t">Schedules</div>
					<div class="key">schedules.sqlite</div>
				</div>
				<div class="r">
					<button
						type="button"
						class="btn pri"
						onClick={() => pickSchedule(null)}
					>
						+ New schedule
					</button>
				</div>
			</div>
			<div class="pg">
				<div class="panel">
					<div class="sr h">
						<span></span>
						<span>Message</span>
						<span>Target</span>
						<span>When</span>
						<span>Next</span>
					</div>
					{schedules.value.map((row) => (
						<button
							type="button"
							key={row.id}
							class={`sr ${row.id === scheduleId.value ? "sel" : ""}`}
							onClick={() => pickSchedule(row.id)}
						>
							<span>{row.kind === "cron" ? "⏱" : "⏰"}</span>
							<span>{row.text}</span>
							<span class="key">{targetLabel(row)}</span>
							<span class="mono">
								{row.kind === "cron" ? row.cron : "when · once"}
							</span>
							<span>
								{row.nextRun ? new Date(row.nextRun).toLocaleString() : ""}
							</span>
						</button>
					))}
				</div>
				<Editor key={draft.id ?? "new"} draft={draft} />
			</div>
		</main>
	);
}

function Editor({ draft }: { draft: Draft }) {
	const [text, setText] = useState(draft.text);
	const [kind, setKind] = useState(draft.kind);
	const [cron, setCron] = useState(draft.cron);
	const [when, setWhen] = useState(draft.when);
	const [mode, setMode] = useState(draft.mode);
	const [chat, setChat] = useState(draft.chatId);
	const [confirmDelete, setConfirmDelete] = useState(false);
	return (
		<div class="panel editor">
			<div class="f span">
				<label>
					Message the bot receives
					<input
						class="inp"
						value={text}
						onInput={(event) =>
							setText((event.currentTarget as HTMLInputElement).value)
						}
					/>
				</label>
			</div>
			<div class="f">
				<div class="lab">Kind</div>
				<div class="seg">
					<button
						type="button"
						class={kind === "cron" ? "on" : ""}
						onClick={() => setKind("cron")}
					>
						cron · repeating
					</button>
					<button
						type="button"
						class={kind === "when" ? "on" : ""}
						onClick={() => setKind("when")}
					>
						when · once
					</button>
				</div>
				{kind === "cron" ? (
					<input
						class="inp mono"
						style="margin-top:8px"
						value={cron}
						onInput={(event) =>
							setCron((event.currentTarget as HTMLInputElement).value)
						}
					/>
				) : (
					<input
						class="inp"
						style="margin-top:8px"
						type="datetime-local"
						value={when}
						onInput={(event) =>
							setWhen((event.currentTarget as HTMLInputElement).value)
						}
					/>
				)}
			</div>
			<div class="f">
				<div class="lab">Target</div>
				<div class="opts">
					<button
						type="button"
						class={`opt ${mode === "chat" ? "on" : ""}`}
						onClick={() => setMode("chat")}
					>
						<b>Chat</b>existing chat, delivered
					</button>
					<button
						type="button"
						class={`opt ${mode === "new-chat" ? "on" : ""}`}
						onClick={() => setMode("new-chat")}
					>
						<b>New chat</b>fresh chat each run
					</button>
					<button
						type="button"
						class={`opt ${mode === "fork" ? "on" : ""}`}
						onClick={() => setMode("fork")}
					>
						<b>Fork</b>silent; files only
					</button>
				</div>
				{mode !== "new-chat" ? (
					<select
						class="inp"
						style="margin-top:8px"
						value={chat}
						onChange={(event) =>
							setChat((event.currentTarget as HTMLSelectElement).value)
						}
					>
						{chats.value.map((item) => (
							<option key={item.key} value={item.key}>
								{item.title || item.key}
							</option>
						))}
					</select>
				) : null}
			</div>
			<div class="span actions">
				{draft.id ? (
					<button
						type="button"
						class="btn ghost bad"
						onClick={() => setConfirmDelete(true)}
					>
						Delete
					</button>
				) : (
					<span />
				)}
				{draft.id ? (
					<button
						type="button"
						class="btn"
						onClick={() => {
							const id = draft.id;
							if (!id) return;
							void runSchedule(id).catch(show);
						}}
					>
						Run now
					</button>
				) : null}
				<button
					type="button"
					class="btn pri"
					onClick={() =>
						void save(draft.id, text, kind, cron, when, mode, chat).catch(show)
					}
				>
					Save
				</button>
			</div>
			{confirmDelete && draft.id ? (
				<ConfirmDialog
					title="Delete this schedule?"
					confirmLabel="Delete"
					onCancel={() => setConfirmDelete(false)}
					onConfirm={() => {
						const id = draft.id;
						setConfirmDelete(false);
						if (!id) return;
						void deleteSchedule(id).catch(show);
					}}
				>
					It stops running and cannot be restored.
				</ConfirmDialog>
			) : null}
		</div>
	);
}

async function save(
	id: string | undefined,
	text: string,
	kind: "cron" | "when",
	cron: string,
	when: string,
	mode: Draft["mode"],
	chatId: string,
) {
	const target = mode === "new-chat" ? { mode } : { mode, chatId };
	const whenMs = when ? new Date(when).getTime() : Date.now();
	await saveSchedule({ id, text, kind, cron, when: whenMs, target });
}

function targetLabel(row: ScheduleRow): string {
	if (row.target.mode === "new-chat") return "new-chat";
	return `${row.target.mode} ${row.target.chatId ?? ""}`;
}

function toLocal(ms: number): string {
	const date = new Date(ms);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function show(error: Error) {
	banner.value = error.message;
}

export function ensureSchedules(): void {
	void loadSchedules().catch(show);
}
