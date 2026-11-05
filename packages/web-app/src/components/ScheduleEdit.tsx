import type { ScheduleRecord } from "@cadmus/contract/types";
import { useState } from "react";
import { Toggle } from "@/components/Toggle";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { describeSchedule } from "@/lib/describe-schedule";

type Repeat = "daily" | "weekly" | "cron" | "absolute" | "relative";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function fromSchedule(schedule: ScheduleRecord | null): {
	name: string;
	text: string;
	enabled: boolean;
	repeat: Repeat;
	time: string;
	weekday: string;
	cron: string;
	absolute: string;
	relative: string;
} {
	const base = {
		name: schedule?.name ?? "",
		text: schedule?.text ?? "",
		enabled: schedule?.enabled ?? true,
		repeat: "daily" as Repeat,
		time: "07:00",
		weekday: "0",
		cron: "0 7 * * *",
		absolute: "",
		relative: "10m",
	};
	if (!schedule) return base;
	if (schedule.kind === "relative") {
		return { ...base, repeat: "relative", relative: String(schedule.input) };
	}
	if (schedule.kind === "absolute") {
		return { ...base, repeat: "absolute", absolute: String(schedule.input) };
	}
	const raw = String(schedule.input).trim();
	const parts = raw.split(/\s+/);
	if (
		parts.length >= 5 &&
		parts[2] === "*" &&
		(parts[4] === "*" || parts[4] === "?") &&
		/^\d+$/.test(parts[0] ?? "") &&
		/^\d+$/.test(parts[1] ?? "")
	) {
		const hh = (parts[1] ?? "0").padStart(2, "0");
		const mm = (parts[0] ?? "0").padStart(2, "0");
		return { ...base, repeat: "daily", time: `${hh}:${mm}`, cron: raw };
	}
	if (
		parts.length >= 5 &&
		parts[2] === "*" &&
		parts[4] &&
		/^\d$/.test(parts[4]) &&
		/^\d+$/.test(parts[0] ?? "") &&
		/^\d+$/.test(parts[1] ?? "")
	) {
		const hh = (parts[1] ?? "0").padStart(2, "0");
		const mm = (parts[0] ?? "0").padStart(2, "0");
		return {
			...base,
			repeat: "weekly",
			time: `${hh}:${mm}`,
			weekday: String(Number(parts[4]) % 7),
			cron: raw,
		};
	}
	return { ...base, repeat: "cron", cron: raw };
}

function toTiming(draft: ReturnType<typeof fromSchedule>): {
	kind: "cron" | "absolute" | "relative";
	input: string;
} {
	if (draft.repeat === "relative") {
		return { kind: "relative", input: draft.relative.trim() || "10m" };
	}
	if (draft.repeat === "absolute") {
		return { kind: "absolute", input: draft.absolute.trim() };
	}
	if (draft.repeat === "cron") {
		return { kind: "cron", input: draft.cron.trim() };
	}
	const [hh, mm] = draft.time.split(":");
	const minute = String(Number(mm ?? "0"));
	const hour = String(Number(hh ?? "0"));
	if (draft.repeat === "weekly") {
		return { kind: "cron", input: `${minute} ${hour} * * ${draft.weekday}` };
	}
	return { kind: "cron", input: `${minute} ${hour} * * *` };
}

export function ScheduleEdit({
	schedule,
	timeZone,
	onSave,
	onDelete,
}: {
	schedule: ScheduleRecord | null;
	timeZone: string;
	onSave: (draft: {
		name: string;
		text: string;
		enabled: boolean;
		kind: "cron" | "absolute" | "relative";
		input: string;
	}) => void;
	onDelete?: () => void;
}) {
	const [draft, setDraft] = useState(() => fromSchedule(schedule));
	const timing = toTiming(draft);
	const preview = describeSchedule(
		{
			kind: timing.kind,
			input: timing.input,
			nextRun: schedule?.nextRun,
			enabled: draft.enabled,
			timeZone,
		},
		Date.now(),
	);
	return (
		<form
			className="flex flex-col gap-3 px-3 py-3"
			onSubmit={(event) => {
				event.preventDefault();
				onSave({
					name: draft.name.trim(),
					text: draft.text,
					enabled: draft.enabled,
					kind: timing.kind,
					input: timing.input,
				});
			}}
		>
			<label className="flex flex-col gap-1 text-[length:var(--fs-sm)] text-text-muted">
				Name
				<input
					aria-label="Schedule name"
					value={draft.name}
					onChange={(event) =>
						setDraft((prev) => ({ ...prev, name: event.target.value }))
					}
					className="min-h-tap rounded-md border border-border bg-surface px-3 text-[length:var(--fs-md)] text-text"
				/>
			</label>
			<label
				htmlFor="schedule-prompt"
				className="flex flex-col gap-1 text-[length:var(--fs-sm)] text-text-muted"
			>
				Prompt
				<Textarea
					id="schedule-prompt"
					aria-label="Schedule prompt"
					value={draft.text}
					rows={5}
					onChange={(event) =>
						setDraft((prev) => ({ ...prev, text: event.target.value }))
					}
					className="font-mono"
				/>
			</label>
			<label className="flex flex-col gap-1 text-[length:var(--fs-sm)] text-text-muted">
				Timing
				<select
					aria-label="Schedule timing"
					value={draft.repeat}
					onChange={(event) =>
						setDraft((prev) => ({
							...prev,
							repeat: event.target.value as Repeat,
						}))
					}
					className="min-h-tap rounded-md border border-border bg-surface px-3 text-[length:var(--fs-md)] text-text"
				>
					<option value="daily">Every day</option>
					<option value="weekly">Weekly</option>
					<option value="cron">Cron expression</option>
					<option value="absolute">Once, at a time</option>
					<option value="relative">Once, after a delay</option>
				</select>
			</label>
			{draft.repeat === "daily" || draft.repeat === "weekly" ? (
				<label className="flex flex-col gap-1 text-[length:var(--fs-sm)] text-text-muted">
					Time
					<input
						aria-label="Schedule time"
						type="time"
						value={draft.time}
						onChange={(event) =>
							setDraft((prev) => ({ ...prev, time: event.target.value }))
						}
						className="min-h-tap rounded-md border border-border bg-surface px-3 text-[length:var(--fs-md)] text-text"
					/>
				</label>
			) : null}
			{draft.repeat === "weekly" ? (
				<label className="flex flex-col gap-1 text-[length:var(--fs-sm)] text-text-muted">
					Weekday
					<select
						aria-label="Schedule weekday"
						value={draft.weekday}
						onChange={(event) =>
							setDraft((prev) => ({ ...prev, weekday: event.target.value }))
						}
						className="min-h-tap rounded-md border border-border bg-surface px-3 text-[length:var(--fs-md)] text-text"
					>
						{WEEKDAYS.map((day, index) => (
							<option key={day} value={String(index)}>
								{day}
							</option>
						))}
					</select>
				</label>
			) : null}
			{draft.repeat === "cron" ? (
				<label className="flex flex-col gap-1 text-[length:var(--fs-sm)] text-text-muted">
					Cron
					<input
						aria-label="Cron expression"
						value={draft.cron}
						onChange={(event) =>
							setDraft((prev) => ({ ...prev, cron: event.target.value }))
						}
						className="min-h-tap rounded-md border border-border bg-surface px-3 font-mono text-[length:var(--fs-md)] text-text"
					/>
				</label>
			) : null}
			{draft.repeat === "absolute" ? (
				<input
					aria-label="Schedule date"
					value={draft.absolute}
					placeholder="2026-04-12T07:00:00"
					onChange={(event) =>
						setDraft((prev) => ({ ...prev, absolute: event.target.value }))
					}
					className="min-h-tap rounded-md border border-border bg-surface px-3 text-[length:var(--fs-md)] text-text"
				/>
			) : null}
			{draft.repeat === "relative" ? (
				<input
					aria-label="Schedule delay"
					value={draft.relative}
					onChange={(event) =>
						setDraft((prev) => ({ ...prev, relative: event.target.value }))
					}
					className="min-h-tap rounded-md border border-border bg-surface px-3 text-[length:var(--fs-md)] text-text"
				/>
			) : null}
			<p className="text-[length:var(--fs-sm)] text-text-muted">{preview}</p>
			<Toggle
				label="Enabled"
				checked={draft.enabled}
				onCheckedChange={(enabled) =>
					setDraft((prev) => ({ ...prev, enabled }))
				}
			/>
			<Button type="submit" disabled={!draft.text.trim() || !timing.input}>
				Save
			</Button>
			{onDelete ? (
				<Button variant="danger" onClick={onDelete}>
					Delete
				</Button>
			) : null}
		</form>
	);
}
