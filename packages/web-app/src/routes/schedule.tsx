import type { ScheduleRecord } from "@cadmus/contract/types";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { ScheduleEdit } from "@/components/ScheduleEdit";
import { useCadmus } from "@/context/CadmusContext";

export function SchedulePage({
	botId,
	id,
	from,
}: {
	botId: string;
	id: string;
	from?: "all";
}) {
	const navigate = useNavigate();
	const { client, bots } = useCadmus();
	const bot = bots.find((entry) => entry.id === botId);
	const creating = id === "new";
	const [schedule, setSchedule] = useState<ScheduleRecord | null>(null);

	useEffect(() => {
		if (creating) return;
		let cancelled = false;
		void client
			.callRpc<{ schedules?: ScheduleRecord[] }>("schedule.list", { botId })
			.then((res) => {
				if (cancelled) return;
				setSchedule(
					res.result?.schedules?.find((item) => item.id === id) ?? null,
				);
			});
		return () => {
			cancelled = true;
		};
	}, [botId, client, creating, id]);

	function back() {
		if (from === "all") {
			void navigate({ to: "/settings/schedules" });
			return;
		}
		void navigate({
			to: "/bot/$botId/$tab",
			params: { botId, tab: "schedules" },
		});
	}

	return (
		<AppShell
			title={creating ? "New schedule" : "Schedule"}
			backTo={
				from === "all" ? "/settings/schedules" : `/bot/${botId}/schedules`
			}
		>
			{!creating && !schedule ? (
				<p className="px-3 py-4 text-text-muted">Loading schedule…</p>
			) : (
				<ScheduleEdit
					schedule={schedule}
					timeZone={bot?.timezone ?? "UTC"}
					onDelete={
						creating
							? undefined
							: () => {
									void client
										.callRpc("schedule.delete", { id })
										.then(() => back());
								}
					}
					onSave={(draft) => {
						const payload = {
							name: draft.name || undefined,
							text: draft.text,
							enabled: draft.enabled,
							kind: draft.kind,
							input: draft.input,
							target: { mode: "new-chat" as const },
						};
						const call = creating
							? client.callRpc("schedule.create", { botId, ...payload })
							: client.callRpc("schedule.update", {
									id,
									name: payload.name,
									text: payload.text,
									enabled: payload.enabled,
									kind: payload.kind,
									input: payload.input,
								});
						void call.then(() => back());
					}}
				/>
			)}
		</AppShell>
	);
}
