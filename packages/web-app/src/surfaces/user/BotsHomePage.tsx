import { Bot } from "lucide-react";
import { useMemo } from "react";
import { useCadmus } from "@/context/CadmusContext";
import { BotStreamPage } from "@/surfaces/user/BotStreamPage";
import { BotsSidebarPanel } from "@/surfaces/user/BotsSidebarPanel";
import { UserShell } from "@/surfaces/user/UserShell";

export function BotsHomePage() {
	const { bots, lastBotId, directoryReady } = useCadmus();

	const activeBotId = useMemo(() => {
		if (lastBotId && bots.some((b) => b.id === lastBotId)) return lastBotId;
		return bots[0]?.id;
	}, [bots, lastBotId]);

	return (
		<UserShell
			activeTab="bots"
			mobileTitle="Bots"
			sidepanel={<BotsSidebarPanel activeBotId={activeBotId} />}
		>
			{/* Mobile (< md): Contact directory of Bots + Bot Groups */}
			<div className="flex min-h-0 flex-1 flex-col md:hidden">
				<BotsSidebarPanel activeBotId={activeBotId} />
			</div>

			{/* Desktop (>= md): Active continuous bot stream or empty workspace state */}
			<div className="hidden min-h-0 flex-1 md:flex">
				{activeBotId ? (
					<BotStreamPage botId={activeBotId} />
				) : !directoryReady ? (
					<div className="flex flex-1 items-center justify-center text-xs text-text-muted">
						Loading workspace…
					</div>
				) : (
					<div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
						<div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl border border-border bg-surface text-accent">
							<Bot className="h-6 w-6" />
						</div>
						<h1 className="text-base font-semibold text-text">
							No bots in this Bot Group yet
						</h1>
						<p className="mt-1 max-w-sm text-xs text-text-muted">
							Use the <strong>+ Bot</strong> button in the left panel to create
							your first continuous-conversation bot.
						</p>
					</div>
				)}
			</div>
		</UserShell>
	);
}
