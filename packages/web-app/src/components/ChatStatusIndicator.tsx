import type { ChatStatusRecord } from "@cadmus/contract/types";
import { useState } from "react";
import { BottomSheet } from "@/components/BottomSheet";
import { StatusShape } from "@/components/StatusShape";

function toolsEnvLine(env: ChatStatusRecord["toolsEnv"]): string {
	if (!env?.enabled) return "Off";
	const parts = [env.kind, env.envId, env.status].filter(
		(part): part is string => Boolean(part),
	);
	return parts.length > 0 ? parts.join(" · ") : "On";
}

function nextWakeLine(at: number | null | undefined): string {
	if (at == null) return "None";
	return new Date(at).toLocaleString();
}

export function ChatStatusIndicator({
	status,
	busy,
	model,
}: {
	status?: ChatStatusRecord;
	busy: boolean;
	model?: string;
}) {
	const [open, setOpen] = useState(false);
	const modelId = status?.model ?? model;
	const label = busy ? "Working…" : "Idle";
	const compact = modelId ? `${label} · ${modelId}` : label;
	const thinking = status?.thinking ?? "—";
	const openTasks = status?.tasks?.open ?? 0;
	const doneTasks = status?.tasks?.done ?? 0;
	const loopRound = status?.tasks?.loopRound;

	return (
		<>
			<button
				type="button"
				aria-label="Bot status"
				onClick={() => setOpen(true)}
				className="inline-flex min-h-0 max-w-full items-center gap-1 truncate text-left text-[length:var(--fs-sm)] text-text-muted"
			>
				{busy ? <StatusShape status="running" /> : null}
				<span className="truncate">{compact}</span>
			</button>
			<BottomSheet
				open={open}
				onOpenChange={setOpen}
				title="Bot status"
				cancelLabel="Close"
			>
				<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 px-1 text-[length:var(--fs-sm)]">
					<dt className="text-text-muted">State</dt>
					<dd>{label}</dd>
					<dt className="text-text-muted">Model</dt>
					<dd className="truncate">{modelId ?? "—"}</dd>
					<dt className="text-text-muted">Thinking</dt>
					<dd>{thinking}</dd>
					<dt className="text-text-muted">Tasks</dt>
					<dd>
						{openTasks} open / {doneTasks} done
						{loopRound != null ? ` · loop ${loopRound}` : ""}
					</dd>
					<dt className="text-text-muted">Next wake</dt>
					<dd>{nextWakeLine(status?.nextWakeAt)}</dd>
					<dt className="text-text-muted">Tools env</dt>
					<dd className="truncate">{toolsEnvLine(status?.toolsEnv)}</dd>
				</dl>
			</BottomSheet>
		</>
	);
}
