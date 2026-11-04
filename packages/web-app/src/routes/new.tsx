import { AppShell } from "@/components/AppShell";
import { Composer } from "@/components/Composer";
import { useCadmus } from "@/context/CadmusContext";

export function NewTaskPage({ botId }: { botId?: string }) {
	const { bots, createChatAndSubmit } = useCadmus();
	const bot = bots.find((entry) => entry.id === botId) ?? bots[0];

	return (
		<AppShell
			title="New task"
			titleMuted
			backTo="/"
			actions={
				<button
					type="button"
					aria-label="Chat menu"
					disabled
					className="inline-flex min-h-tap min-w-tap items-center justify-center text-text-muted disabled:opacity-40"
				>
					⋯
				</button>
			}
		>
			<div className="flex min-h-0 flex-1 flex-col">
				<p className="flex-1 px-6 py-16 text-center text-[length:var(--fs-sm)] text-text-muted">
					Describe the task in as much detail as you like.
					<br />
					The bot takes it from there.
				</p>
				<Composer
					placeholder="Message"
					autoFocus
					disabled={!bot}
					onSend={(text) => {
						if (!bot) return;
						void createChatAndSubmit(bot.id, text);
					}}
				/>
			</div>
		</AppShell>
	);
}
