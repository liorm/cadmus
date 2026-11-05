import type { ScheduleRecord } from "@cadmus/contract/types";
import { useNavigate } from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";
import { ScheduleList } from "@/components/ScheduleList";
import { useCadmus } from "@/context/CadmusContext";
import { useScopedResource } from "@/hooks/useScopedResource";

export function AllSchedulesPage() {
	const navigate = useNavigate();
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
	const schedules = loaded.data ?? [];

	return (
		<AppShell title="All schedules" backTo="/settings">
			<div className="min-h-0 flex-1 overflow-y-auto">
				<ScheduleList
					grouped
					bots={bots}
					phase={loaded.phase}
					error={loaded.error}
					onRetry={loaded.retry}
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
							.then(() => loaded.retry());
					}}
				/>
			</div>
		</AppShell>
	);
}
