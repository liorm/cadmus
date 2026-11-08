import type { BotRecord } from "@cadmus/contract/types";
import { BotBadge } from "@/components/BotBadge";
import { Markdown } from "@/components/Markdown";
import { StatusShape } from "@/components/StatusShape";
import { Button } from "@/components/ui/button";
import {
	Sheet,
	SheetClose,
	SheetContent,
	SheetDescription,
	SheetTitle,
} from "@/components/ui/sheet";
import { formatRelative } from "@/lib/format-time";
import type { GroupChatMessage } from "@/lib/group-chat-data";
import { cn } from "@/lib/utils";

export interface GroupChatViewerSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	topic?: string;
	status?: "ended" | "capped" | "timed_out" | "pending" | "running" | string;
	members?: string[];
	transcript?: GroupChatMessage[];
	response?: string;
	groupId?: string;
	bots?: BotRecord[];
}

export function GroupChatViewerSheet({
	open,
	onOpenChange,
	topic = "Group Chat",
	status,
	members = [],
	transcript = [],
	response,
	bots = [],
}: GroupChatViewerSheetProps) {
	const botMap = new Map<string, BotRecord>();
	for (const b of bots) {
		botMap.set(b.id, b);
	}

	const isLive = status === "running" || status === "pending";

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="flex max-h-[88vh] w-full max-w-lg flex-col p-4 sm:max-w-xl">
				<header className="border-b border-border pb-3">
					<div className="flex items-center justify-between gap-2">
						<div className="flex items-center gap-2">
							{isLive ? <StatusShape status="running" /> : null}
							<span className="text-[length:var(--fs-xs)] font-medium tracking-wide text-text-muted uppercase">
								Inter-bot group chat
							</span>
						</div>
						{status ? (
							<span
								className={cn(
									"rounded px-2 py-0.5 text-[length:var(--fs-xs)] font-medium",
									status === "ended"
										? "bg-status-success/15 text-status-success"
										: status === "running" || status === "pending"
											? "bg-status-running/15 text-status-running"
											: "bg-status-failed/15 text-status-failed",
								)}
							>
								{status}
							</span>
						) : null}
					</div>

					<SheetTitle className="mt-1 line-clamp-2 text-[length:var(--fs-md)] font-semibold text-text">
						{topic}
					</SheetTitle>
					<SheetDescription className="sr-only">
						Inter-bot group conversation for {topic}
					</SheetDescription>

					{members.length > 0 ? (
						<div className="mt-2 flex flex-wrap items-center gap-2">
							<span className="text-[length:var(--fs-xs)] text-text-muted">
								Members:
							</span>
							{members.map((memberId) => {
								const bot = botMap.get(memberId) ?? {
									id: memberId,
									name: memberId,
								};
								return (
									<span
										key={memberId}
										className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-raised px-2 py-0.5 text-[length:var(--fs-xs)] text-text"
									>
										<BotBadge
											bot={bot}
											className="size-4 min-h-0 min-w-0 text-[10px]"
										/>
										<span className="font-medium">{bot.name ?? memberId}</span>
									</span>
								);
							})}
						</div>
					) : null}
				</header>

				<div
					data-testid="group-chat-messages"
					className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto py-3 pr-1"
				>
					{transcript.length === 0 ? (
						<p className="py-8 text-center text-[length:var(--fs-sm)] text-text-muted">
							{isLive
								? "Bots are communicating..."
								: "No conversation messages recorded."}
						</p>
					) : (
						transcript.map((msg) => {
							const bot = botMap.get(msg.fromBotId) ?? {
								id: msg.fromBotId,
								name: msg.fromBotId,
							};
							return (
								<div
									key={`${msg.fromBotId}-${msg.at}-${msg.text.slice(0, 16)}`}
									className="rounded-lg border border-border bg-surface-raised p-3"
								>
									<div className="mb-1 flex items-center justify-between gap-2">
										<div className="flex items-center gap-1.5">
											<BotBadge
												bot={bot}
												className="size-5 min-h-0 min-w-0 text-[10px]"
											/>
											<span className="text-[length:var(--fs-xs)] font-semibold text-text">
												{bot.name ?? msg.fromBotId}
											</span>
										</div>
										<time className="text-[length:var(--fs-xs)] text-text-muted">
											{formatRelative(msg.at)}
										</time>
									</div>
									<div className="text-[length:var(--fs-sm)] text-text">
										<Markdown source={msg.text} />
									</div>
								</div>
							);
						})
					)}

					{response ? (
						<div className="mt-1 rounded-lg border border-status-success/30 bg-status-success/5 p-3">
							<div className="mb-1 text-[length:var(--fs-xs)] font-semibold text-status-success">
								✓ Final Resolution
							</div>
							<div className="text-[length:var(--fs-sm)] text-text">
								<Markdown source={response} />
							</div>
						</div>
					) : null}
				</div>

				<footer className="border-t border-border pt-3">
					<SheetClose asChild>
						<Button variant="outlined" className="w-full">
							Close
						</Button>
					</SheetClose>
				</footer>
			</SheetContent>
		</Sheet>
	);
}
