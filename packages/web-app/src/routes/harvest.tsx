import { AppShell } from "@/components/AppShell";
import { BotBadge } from "@/components/BotBadge";
import { HarvestView } from "@/components/HarvestView";
import { useCadmus } from "@/context/CadmusContext";

export function HarvestPage({ botId }: { botId: string }) {
	const { bots } = useCadmus();
	const bot = bots.find((entry) => entry.id === botId);
	return (
		<AppShell
			title="Harvest"
			backTo={`/bot/${botId}/config`}
			titleNode={
				<h1 className="flex min-w-0 items-center gap-2 text-[length:var(--fs-lg)] font-semibold">
					{bot ? (
						<BotBadge bot={bot} className="size-8 min-h-0 min-w-0" />
					) : null}
					<span className="truncate">Harvest</span>
				</h1>
			}
		>
			<HarvestView botId={botId} />
		</AppShell>
	);
}
