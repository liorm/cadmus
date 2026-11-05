import type { BotRecord } from "@cadmus/contract/types";
import { useState } from "react";
import { BotBadge } from "@/components/BotBadge";
import { BottomSheet } from "@/components/BottomSheet";
import { ColorSwatches } from "@/components/ColorSwatches";
import { Button } from "@/components/ui/button";
import { useCadmus } from "@/context/CadmusContext";
import { type BotPaletteSlot, botColor } from "@/lib/bot-color";

export function GroupMenuSheet({
	bot,
	openChatCount,
	open,
	onOpenChange,
	onProfile,
	onNewChat,
	onArchived,
}: {
	bot: BotRecord;
	openChatCount: number;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onProfile: () => void;
	onNewChat: () => void;
	onArchived: () => void;
}) {
	const { client, refreshDirectory, chats } = useCadmus();
	const [confirmArchive, setConfirmArchive] = useState(false);
	const [pickingColor, setPickingColor] = useState(false);
	const slot = botColor(bot);

	async function applyColor(next: BotPaletteSlot) {
		await client.callRpc("bot.update", {
			botId: bot.id,
			metadata: { color: `bot-${next}` },
		});
		await refreshDirectory();
		setPickingColor(false);
		onOpenChange(false);
	}

	async function archiveAll() {
		const keys = chats
			.filter((chat) => chat.botId === bot.id && !chat.closed)
			.map((chat) => chat.key);
		await Promise.all(
			keys.map((chatKey) => client.callRpc("chat.close", { chatKey })),
		);
		await refreshDirectory();
		setConfirmArchive(false);
		onOpenChange(false);
		onArchived();
	}

	return (
		<>
			<BottomSheet
				open={open && !pickingColor && !confirmArchive}
				onOpenChange={onOpenChange}
				title={bot.name}
				leading={
					<BotBadge
						bot={bot}
						className="size-9 min-h-0 min-w-0 text-[length:var(--fs-sm)]"
					/>
				}
			>
				<button
					type="button"
					className="flex min-h-tap w-full items-center gap-3 text-left"
					onClick={onProfile}
				>
					<span className="flex-1">Profile</span>
					<span className="text-[length:var(--fs-sm)] text-text-muted">
						Schedules, memory, files, soul
					</span>
				</button>
				<button
					type="button"
					className="flex min-h-tap w-full items-center text-left"
					onClick={onNewChat}
				>
					New chat with this bot
				</button>
				<button
					type="button"
					className="flex min-h-tap w-full items-center gap-3 text-left"
					onClick={() => setConfirmArchive(true)}
				>
					<span className="flex-1">Archive all chats</span>
					<span className="text-[length:var(--fs-sm)] text-text-muted">
						{openChatCount} {openChatCount === 1 ? "chat" : "chats"}
					</span>
				</button>
				<button
					type="button"
					className="flex min-h-tap w-full items-center text-left"
					onClick={() => setPickingColor(true)}
				>
					Change colour
				</button>
			</BottomSheet>
			<BottomSheet
				open={pickingColor}
				onOpenChange={setPickingColor}
				title="Change colour"
				leading={
					<BotBadge
						bot={bot}
						className="size-9 min-h-0 min-w-0 text-[length:var(--fs-sm)]"
					/>
				}
			>
				<ColorSwatches
					value={slot}
					onChange={(next) => void applyColor(next)}
				/>
			</BottomSheet>
			<BottomSheet
				open={confirmArchive}
				onOpenChange={setConfirmArchive}
				title={`Archive all chats for ${bot.name}?`}
				description="Open chats with this bot become read-only."
				cancelLabel="Cancel"
			>
				<Button variant="danger" onClick={() => void archiveAll()}>
					Archive all
				</Button>
			</BottomSheet>
		</>
	);
}
