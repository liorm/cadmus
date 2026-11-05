import type { ScheduleRecord } from "@cadmus/contract/types";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { ScheduleList } from "@/components/ScheduleList";
import { useCadmus } from "@/context/CadmusContext";

export function AllSchedulesPage() {
	const navigate = useNavigate();
	const { client, bots } = useCadmus();
	const [schedules, setSchedules] = useState<ScheduleRecord[]>([]);

	const load = useCallback(async () => {
		const res = await client.callRpc<{ schedules?: ScheduleRecord[] }>(
			"schedule.list",
		);
		setSchedules(res.result?.schedules ?? []);
	}, [client]);

	useEffect(() => {
		void load();
	}, [load]);

	return (
		<AppShell title="All schedules" backTo="/settings">
			<div className="min-h-0 flex-1 overflow-y-auto">
				<ScheduleList
					grouped
					bots={bots}
					schedules={schedules}
					timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"}
					onOpen={(id) => {
						const schedule = schedules.find((item) => item.id === id);
						if (!schedule) return;
						void navigate({
							to: "/bot/$botId/schedule/$id",
							params: { botId: schedule.botId, id },
							search: { from: "all" },
						});
					}}
					onToggle={(schedule, enabled) => {
						void client
							.callRpc("schedule.update", { id: schedule.id, enabled })
							.then(() => load());
					}}
				/>
			</div>
		</AppShell>
	);
}
