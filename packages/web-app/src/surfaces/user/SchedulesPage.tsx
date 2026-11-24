import type { ScheduleRecord } from "@cadmus/contract/types";
import { CalendarClock, Plus } from "lucide-react";
import { useState } from "react";
import { AddEntityDialog } from "@/components/chrome/AddEntityDialog";
import { ScheduleEdit } from "@/components/ScheduleEdit";
import { ScheduleList } from "@/components/ScheduleList";
import { useCadmus } from "@/context/CadmusContext";
import { useScopedResource } from "@/hooks/useScopedResource";
import { UserShell } from "@/surfaces/user/UserShell";

export function SchedulesPage() {
	const { client, bots, familyId } = useCadmus();
	const loaded = useScopedResource(`${familyId}:schedules`, async () => {
		const res = await client.callRpc<{ schedules?: ScheduleRecord[] }>(
			"schedule.list",
		);
		if (!res.ok) {
			throw new Error(res.error?.message ?? "Could not load schedules");
		}
		return res.result?.schedules ?? [];
	});

	const [dialogOpen, setDialogOpen] = useState(false);
	const [editing, setEditing] = useState<ScheduleRecord | null>(null);
	const [botId, setBotId] = useState("");
	const [saveError, setSaveError] = useState<string | null>(null);

	const schedules = (loaded.data ?? []).filter((s) => !s.internal);
	const selectedBotId =
		editing?.botId ??
		(botId && bots.some((b) => b.id === botId) ? botId : (bots[0]?.id ?? ""));
	const activeBot = bots.find((b) => b.id === selectedBotId);

	return (
		<UserShell activeTab="schedules" mobileTitle="Schedules">
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
				<header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface px-4 py-3 sm:px-6">
					<div className="flex items-center gap-2.5">
						<CalendarClock className="h-5 w-5 text-accent" />
						<div>
							<h1 className="text-sm font-semibold text-text">Schedules</h1>
							<p className="text-xs text-text-muted">
								Cron, daily, weekly, and one-shot bot triggers in this group
							</p>
						</div>
					</div>
					<button
						type="button"
						disabled={bots.length === 0}
						onClick={() => {
							setEditing(null);
							setBotId(bots[0]?.id ?? "");
							setSaveError(null);
							setDialogOpen(true);
						}}
						className="inline-flex min-h-tap items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-semibold text-on-accent hover:opacity-90 disabled:opacity-50"
					>
						<Plus className="h-3.5 w-3.5" />
						New schedule
					</button>
				</header>

				<div className="mx-auto w-full max-w-4xl flex-1 p-2 sm:p-4">
					<ScheduleList
						grouped
						bots={bots}
						phase={loaded.phase}
						error={loaded.error}
						onRetry={loaded.retry}
						schedules={schedules}
						timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"}
						onOpen={(id) => {
							const found = schedules.find((item) => item.id === id) ?? null;
							if (!found) return;
							setEditing(found);
							setBotId(found.botId);
							setSaveError(null);
							setDialogOpen(true);
						}}
						onToggle={(schedule, enabled) => {
							void client
								.callRpc("schedule.update", { id: schedule.id, enabled })
								.then(() => loaded.retry());
						}}
					/>
				</div>
			</div>

			<AddEntityDialog
				open={dialogOpen}
				onClose={() => setDialogOpen(false)}
				title={editing ? "Edit schedule" : "New schedule"}
				description="Triggered runs post output into the bot's scheduled workflow."
			>
				<div className="space-y-3">
					{saveError ? (
						<p role="alert" className="text-xs text-destructive">
							{saveError}
						</p>
					) : null}
					{!editing ? (
						<label className="block px-3 space-y-1">
							<span className="text-xs font-medium text-text-muted">Bot</span>
							<select
								aria-label="Target bot"
								value={selectedBotId}
								onChange={(e) => setBotId(e.target.value)}
								className="min-h-tap w-full rounded-md border border-border bg-bg px-3 text-sm text-text"
							>
								{bots.map((b) => (
									<option key={b.id} value={b.id}>
										{b.name}
									</option>
								))}
							</select>
						</label>
					) : null}
					<ScheduleEdit
						schedule={editing}
						timeZone={
							activeBot?.timezone ??
							(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC")
						}
						onSave={(draft) => {
							setSaveError(null);
							const req = editing
								? client.callRpc("schedule.update", {
										id: editing.id,
										name: draft.name,
										text: draft.text,
										enabled: draft.enabled,
										kind: draft.kind,
										input: draft.input,
									})
								: client.callRpc("schedule.create", {
										botId: selectedBotId,
										name: draft.name,
										text: draft.text,
										enabled: draft.enabled,
										kind: draft.kind,
										input: draft.input,
									});
							void req.then((res) => {
								if (!res.ok) {
									setSaveError(
										res.error?.message ?? "Could not save schedule.",
									);
									return;
								}
								setDialogOpen(false);
								loaded.retry();
							});
						}}
						onDelete={
							editing
								? () => {
										void client
											.callRpc("schedule.delete", { id: editing.id })
											.then((res) => {
												if (!res.ok) {
													setSaveError(
														res.error?.message ?? "Could not delete schedule.",
													);
													return;
												}
												setDialogOpen(false);
												loaded.retry();
											});
									}
								: undefined
						}
					/>
				</div>
			</AddEntityDialog>
		</UserShell>
	);
}
