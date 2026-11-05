import type {
	BotRecord,
	ChatRecord,
	ScheduleRecord,
} from "@cadmus/contract/types";
import { BotBadge } from "@/components/BotBadge";
import { LoadGate } from "@/components/Skeleton";
import { Switch } from "@/components/ui/switch";
import { botColor, botColorVar } from "@/lib/bot-color";
import { describeSchedule } from "@/lib/describe-schedule";
import { chatTitle } from "@/lib/format-time";
import type { LoadPhase } from "@/lib/load-state";

function ScheduleRows({
	schedules,
	timeZone,
	onOpen,
	onToggle,
}: {
	schedules: ScheduleRecord[];
	timeZone: string;
	onOpen: (id: string) => void;
	onToggle: (schedule: ScheduleRecord, enabled: boolean) => void;
}) {
	return schedules.map((schedule) => {
		const name = schedule.name?.trim() || "Untitled schedule";
		const line = describeSchedule({ ...schedule, timeZone }, Date.now());
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
	});
}

export function ScheduleList({
	schedules,
	timeZone,
	scheduledChats,
	bots,
	grouped = false,
	phase,
	error,
	onRetry,
	onOpen,
	onToggle,
	onCreate,
	onOpenChat,
}: {
	schedules: ScheduleRecord[];
	timeZone: string;
	scheduledChats?: ChatRecord[];
	bots?: BotRecord[];
	grouped?: boolean;
	phase: LoadPhase;
	error?: string;
	onRetry: () => void;
	onOpen: (id: string) => void;
	onToggle: (schedule: ScheduleRecord, enabled: boolean) => void;
	onCreate?: () => void;
	onOpenChat?: (chatKey: string) => void;
}) {
	const visible = schedules.filter((schedule) => !schedule.internal);
	if (phase !== "ready") {
		return (
			<LoadGate
				phase={phase}
				error={error ?? "Could not load schedules"}
				onRetry={onRetry}
				label="Loading schedules"
			>
				{null}
			</LoadGate>
		);
	}
	if (grouped) {
		const groups = (bots ?? []).map((bot) => ({
			bot,
			schedules: visible.filter((schedule) => schedule.botId === bot.id),
		}));
		return (
			<div className="flex flex-col gap-3 px-3 py-3">
				{groups.every((group) => group.schedules.length === 0) ? (
					<p className="px-1 text-[length:var(--fs-sm)] text-text-muted">
						No schedules yet.
					</p>
				) : null}
				{groups
					.filter((group) => group.schedules.length > 0)
					.map((group) => {
						const slot = botColor(group.bot);
						return (
							<section key={group.bot.id} aria-label={group.bot.name}>
								<header className="mb-2 flex items-center gap-2 px-1">
									<BotBadge
										bot={group.bot}
										className="size-8 min-h-0 min-w-0"
									/>
									<h2 className="truncate font-semibold">{group.bot.name}</h2>
								</header>
								<div className="flex overflow-hidden rounded-md border border-border bg-surface">
									<div
										aria-hidden="true"
										className="w-1 shrink-0"
										style={{ background: botColorVar(slot) }}
									/>
									<div className="min-w-0 flex-1">
										<ScheduleRows
											schedules={group.schedules}
											timeZone={group.bot.timezone || timeZone}
											onOpen={onOpen}
											onToggle={onToggle}
										/>
									</div>
								</div>
							</section>
						);
					})}
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-3 px-3 py-3">
			<div className="overflow-hidden rounded-md border border-border bg-surface">
				{visible.length === 0 ? (
					<p className="px-3 py-4 text-[length:var(--fs-sm)] text-text-muted">
						No schedules yet.
					</p>
				) : (
					<ScheduleRows
						schedules={visible}
						timeZone={timeZone}
						onOpen={onOpen}
						onToggle={onToggle}
					/>
				)}
			</div>
			{onCreate ? (
				<button
					type="button"
					className="flex min-h-tap items-center justify-center rounded-md border border-border text-[length:var(--fs-md)]"
					onClick={onCreate}
				>
					+ New schedule
				</button>
			) : null}
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
