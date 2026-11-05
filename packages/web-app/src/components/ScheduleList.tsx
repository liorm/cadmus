import type { ChatRecord, ScheduleRecord } from "@cadmus/contract/types";
import { Switch } from "@/components/ui/switch";
import { describeSchedule } from "@/lib/describe-schedule";
import { chatTitle } from "@/lib/format-time";

export function ScheduleList({
	schedules,
	timeZone,
	scheduledChats,
	onOpen,
	onToggle,
	onCreate,
	onOpenChat,
}: {
	schedules: ScheduleRecord[];
	timeZone: string;
	scheduledChats?: ChatRecord[];
	onOpen: (id: string) => void;
	onToggle: (schedule: ScheduleRecord, enabled: boolean) => void;
	onCreate: () => void;
	onOpenChat?: (chatKey: string) => void;
}) {
	const visible = schedules.filter((schedule) => !schedule.internal);
	return (
		<div className="flex flex-col gap-3 px-3 py-3">
			<div className="overflow-hidden rounded-md border border-border bg-surface">
				{visible.length === 0 ? (
					<p className="px-3 py-4 text-[length:var(--fs-sm)] text-text-muted">
						No schedules yet.
					</p>
				) : (
					visible.map((schedule) => {
						const name = schedule.name?.trim() || "Untitled schedule";
						const line = describeSchedule(
							{ ...schedule, timeZone },
							Date.now(),
						);
						return (
							<div
								key={schedule.id}
								className="flex min-h-tap items-center gap-2 border-b border-border px-3 last:border-b-0"
							>
								<button
									type="button"
									className="min-w-0 flex-1 py-2 text-left"
									onClick={() => onOpen(schedule.id)}
								>
									<div className="truncate font-semibold">{name}</div>
									<div className="truncate text-[length:var(--fs-sm)] text-text-muted">
										{line}
									</div>
								</button>
								<Switch
									checked={schedule.enabled}
									aria-label={`${schedule.enabled ? "Pause" : "Enable"} ${name}`}
									onCheckedChange={(enabled) => onToggle(schedule, enabled)}
								/>
							</div>
						);
					})
				)}
			</div>
			<button
				type="button"
				className="flex min-h-tap items-center justify-center rounded-md border border-border text-[length:var(--fs-md)]"
				onClick={onCreate}
			>
				+ New schedule
			</button>
			{scheduledChats && scheduledChats.length > 0 ? (
				<section aria-label="Scheduled chats" className="flex flex-col gap-1">
					<h2 className="px-1 text-[length:var(--fs-xs)] font-semibold uppercase tracking-wide text-text-muted">
						Scheduled chats
					</h2>
					<div className="overflow-hidden rounded-md border border-border bg-surface">
						{scheduledChats.map((chat) => (
							<button
								key={chat.key}
								type="button"
								className="flex min-h-tap w-full items-center border-b border-border px-3 text-left last:border-b-0"
								onClick={() => onOpenChat?.(chat.key)}
							>
								{chatTitle(chat)}
							</button>
						))}
					</div>
				</section>
			) : null}
		</div>
	);
}
