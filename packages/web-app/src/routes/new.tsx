import type { BotRecord } from "@cadmus/contract/types";
import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { BotBadge } from "@/components/BotBadge";
import { BotChip } from "@/components/BotChip";
import { BottomSheet } from "@/components/BottomSheet";
import { Composer } from "@/components/Composer";
import { useCadmus } from "@/context/CadmusContext";
import { botColor, botColorVar } from "@/lib/bot-color";
import { cn } from "@/lib/utils";

function ToBotChip({ bot, onOpen }: { bot: BotRecord; onOpen: () => void }) {
	const slot = botColor(bot);
	return (
		<button
			type="button"
			aria-haspopup="dialog"
			aria-label={`To: ${bot.name}`}
			onClick={onOpen}
			className="inline-flex min-h-tap items-center gap-2 text-[length:var(--fs-sm)]"
		>
			<span className="text-text-muted">To</span>
			<span
				className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1"
				style={{ color: botColorVar(slot) }}
			>
				<span
					aria-hidden="true"
					className="size-2 rounded-full"
					style={{ background: botColorVar(slot) }}
				/>
				{bot.name}
				<span aria-hidden="true">▾</span>
			</span>
		</button>
	);
}

export function NewTaskPage({ botId }: { botId?: string }) {
	const { bots, teamLeaderBotId, createChatAndSubmit } = useCadmus();
	const [pickedBotId, setPickedBotId] = useState<string | null>(null);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [letTl, setLetTl] = useState(false);
	const selected =
		(pickedBotId
			? bots.find((entry) => entry.id === pickedBotId)
			: undefined) ??
		bots.find((entry) => entry.id === botId) ??
		bots[0];
	const leader =
		teamLeaderBotId && bots.some((entry) => entry.id === teamLeaderBotId)
			? teamLeaderBotId
			: undefined;

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
					disabled={!selected}
					chips={
						selected ? (
							<>
								<ToBotChip bot={selected} onOpen={() => setPickerOpen(true)} />
								{leader ? (
									<button
										type="button"
										aria-pressed={letTl}
										aria-label="Let TL route"
										onClick={() => setLetTl((on) => !on)}
										className={cn(
											"inline-flex min-h-tap items-center rounded-full border px-3 text-[length:var(--fs-sm)]",
											letTl
												? "border-accent bg-accent text-on-accent"
												: "border-dashed border-border text-text-muted",
										)}
									>
										⇄ Let TL route
									</button>
								) : null}
							</>
						) : (
							<BotChip bots={[]} disabled />
						)
					}
					onSend={(text) => {
						const target = letTl && leader ? leader : selected?.id;
						if (!target) return;
						void createChatAndSubmit(target, text);
					}}
				/>
			</div>
			<BottomSheet
				open={pickerOpen}
				onOpenChange={setPickerOpen}
				title="Choose a bot"
			>
				{bots.map((bot) => (
					<button
						key={bot.id}
						type="button"
						aria-label={bot.name}
						className="flex min-h-tap w-full items-center gap-3 text-left"
						onClick={() => {
							setPickedBotId(bot.id);
							setLetTl(false);
							setPickerOpen(false);
						}}
					>
						<BotBadge bot={bot} className="size-8 min-h-0 min-w-0" />
						<span className="flex-1 truncate">{bot.name}</span>
					</button>
				))}
			</BottomSheet>
		</AppShell>
	);
}
