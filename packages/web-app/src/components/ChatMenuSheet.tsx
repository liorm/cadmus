import type { BotRecord } from "@cadmus/contract/types";
import { BotBadge } from "@/components/BotBadge";
import { BottomSheet } from "@/components/BottomSheet";
import { Toggle } from "@/components/Toggle";

export function ChatMenuSheet({
	open,
	onOpenChange,
	title,
	bot,
	archived,
	harvestOn,
	onHarvestChange,
	onRename,
	onRaw,
	onArchive,
	onOpenProfile,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	bot?: BotRecord;
	archived: boolean;
	harvestOn: boolean;
	onHarvestChange: (on: boolean) => void;
	onRename: () => void;
	onRaw: () => void;
	onArchive: () => void;
	onOpenProfile: () => void;
}) {
	return (
		<BottomSheet
			open={open}
			onOpenChange={onOpenChange}
			title={title}
			leading={
				bot ? (
					<BotBadge
						bot={bot}
						className="size-9 min-h-0 min-w-0 text-[length:var(--fs-sm)]"
					/>
				) : null
			}
		>
			{archived ? null : (
				<button
					type="button"
					className="flex min-h-tap w-full items-center gap-3 text-left"
					onClick={onRename}
				>
					<span aria-hidden="true">✎</span>
					<span className="flex-1">Rename</span>
				</button>
			)}
			{archived ? null : (
				<Toggle
					leading={<span aria-hidden="true">↺</span>}
					label="Harvest this chat"
					checked={harvestOn}
					onCheckedChange={onHarvestChange}
				/>
			)}
			<button
				type="button"
				className="flex min-h-tap w-full items-center gap-3 text-left"
				onClick={onRaw}
			>
				<span aria-hidden="true">{"{ }"}</span>
				<span className="flex-1">View raw transcript</span>
			</button>
			{archived ? null : (
				<button
					type="button"
					className="flex min-h-tap w-full items-center gap-3 text-left"
					onClick={onArchive}
				>
					<span aria-hidden="true">□</span>
					<span className="flex-1">Archive</span>
					<span className="text-[length:var(--fs-sm)] text-text-muted">
						Read-only after
					</span>
				</button>
			)}
			<button
				type="button"
				className="flex min-h-tap w-full items-center gap-3 text-left"
				onClick={onOpenProfile}
				disabled={!bot}
			>
				{bot ? (
					<BotBadge
						bot={bot}
						className="size-7 min-h-0 min-w-0 text-[length:var(--fs-xs)]"
					/>
				) : (
					<span aria-hidden="true">•</span>
				)}
				<span className="flex-1">Open bot profile</span>
				{bot ? (
					<span className="truncate text-[length:var(--fs-sm)] text-text-muted">
						{bot.name}
					</span>
				) : null}
			</button>
		</BottomSheet>
	);
}
