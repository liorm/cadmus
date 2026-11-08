import { Link, useNavigate } from "@tanstack/react-router";
import { type JSX, useMemo, useState } from "react";
import { BotBadge } from "@/components/BotBadge";
import { GroupMenuSheet } from "@/components/GroupMenuSheet";
import { LoadError, Skeleton } from "@/components/Skeleton";
import { rowStatus, StatusShape } from "@/components/StatusShape";
import { UnreadDot } from "@/components/UnreadDot";
import { useCadmus } from "@/context/CadmusContext";
import { chatTitle, formatRelative } from "@/lib/format-time";
import { needsYou } from "@/lib/needs-you";
import { cn } from "@/lib/utils";

const FILTERS = [
	{ id: "all", label: "All" },
	{ id: "running", label: "Running" },
	{ id: "needs", label: "Needs you" },
] as const;

function modelTag(model: string): string {
	const segment = model.split("/").pop()?.trim();
	return segment && segment.length > 0 ? segment : model;
}

export function FleetDeck({
	selectedBotId,
	selectedChatKey,
	filter,
	onFilterChange,
	onSelectBot,
	onSelectChat,
	onNewThread,
}: {
	selectedBotId: string;
	selectedChatKey: string | null;
	filter: "all" | "running" | "needs";
	onFilterChange: (filter: "all" | "running" | "needs") => void;
	onSelectBot: (botId: string) => void;
	onSelectChat: (chatKey: string, botId: string) => void;
	onNewThread: (botId: string) => void;
}): JSX.Element {
	const navigate = useNavigate();
	const [menuBotId, setMenuBotId] = useState<string | null>(null);
	const {
		bots,
		chats,
		chatStates,
		lastSeen,
		directoryReady,
		directoryError,
		refreshDirectory,
		retryChat,
		archiveChat,
	} = useCadmus();

	const menuBot = bots.find((b) => b.id === menuBotId);

	const needsKeys = useMemo(() => {
		const keys = new Set<string>();
		for (const item of needsYou(chats, chatStates, lastSeen)) {
			keys.add(item.chatKey);
		}
		return keys;
	}, [chats, chatStates, lastSeen]);

	const openChats = useMemo(
		() => chats.filter((chat) => !chat.closed),
		[chats],
	);

	const threads = useMemo(() => {
		const visible = openChats.filter((chat) => {
			if (filter === "running") return Boolean(chatStates[chat.key]?.busy);
			if (filter === "needs") return needsKeys.has(chat.key);
			return true;
		});
		return visible.sort((a, b) => {
			const aAt = chatStates[a.key]?.lastBotAt ?? a.createdAt;
			const bAt = chatStates[b.key]?.lastBotAt ?? b.createdAt;
			return bAt - aAt;
		});
	}, [chatStates, filter, needsKeys, openChats]);

	return (
		<aside
			aria-label="Bot fleet and threads"
			className="flex h-full min-h-0 flex-col overflow-hidden bg-surface/40 font-sans"
		>
			<section
				aria-labelledby="fleet-heading"
				className="flex max-h-[46%] min-h-0 flex-col overflow-hidden border-b border-border"
			>
				<div className="flex items-center justify-between gap-2 px-3 pt-3 pb-2">
					<h2
						id="fleet-heading"
						className="text-[length:var(--fs-xs)] font-semibold uppercase tracking-wide text-text-muted"
					>
						Active bot fleet
					</h2>
					<Link
						to="/bot/new"
						className="text-[length:var(--fs-sm)] font-medium text-accent"
					>
						+ New bot
					</Link>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
					{directoryError ? (
						<LoadError
							message={directoryError}
							onRetry={() => void refreshDirectory()}
						/>
					) : !directoryReady ? (
						<div
							role="status"
							aria-busy="true"
							aria-label="Loading bots"
							className="grid grid-cols-2 gap-2"
						>
							<Skeleton className="h-24 w-full rounded-md" />
							<Skeleton className="h-24 w-full rounded-md" />
						</div>
					) : bots.length === 0 ? (
						<div className="flex flex-col items-start gap-2 py-2">
							<p className="text-[length:var(--fs-sm)] text-text-muted">
								No bots yet. Create one to start a thread.
							</p>
							<Link
								to="/bot/new"
								className="text-[length:var(--fs-sm)] font-medium text-accent"
							>
								+ New bot
							</Link>
						</div>
					) : (
						<div className="grid grid-cols-2 gap-2">
							{bots.map((bot) => {
								const botChats = openChats.filter(
									(chat) => chat.botId === bot.id,
								);
								let ring: "error" | "running" | "idle" = "idle";
								for (const chat of botChats) {
									const state = chatStates[chat.key];
									if (state?.failedReason) {
										ring = "error";
										break;
									}
									if (state?.busy) ring = "running";
								}
								const selected = bot.id === selectedBotId;
								return (
									<div
										key={bot.id}
										className={cn(
											"flex min-w-0 flex-col gap-2 rounded-md border border-border bg-surface p-2 text-left",
											selected && "border-accent bg-accent/10",
										)}
									>
										<div className="flex items-center gap-2">
											<button
												type="button"
												aria-pressed={selected}
												onClick={() => onSelectBot(bot.id)}
												className="flex min-w-0 flex-1 items-center gap-2 text-left"
											>
												<BotBadge
													bot={bot}
													className="size-8 min-h-0 min-w-0"
												/>
												<span
													role="img"
													aria-label={ring}
													className={cn(
														"inline-block size-2 shrink-0 rounded-full",
														ring === "error" && "bg-status-failed",
														ring === "running" && "bg-status-running",
														ring === "idle" && "bg-status-done",
													)}
												/>
												<span className="min-w-0 flex-1 truncate font-semibold">
													{bot.name}
												</span>
											</button>
											<button
												type="button"
												aria-label={`${bot.name} menu`}
												className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-text-muted hover:text-text"
												onClick={(event) => {
													event.stopPropagation();
													setMenuBotId(bot.id);
												}}
											>
												⋯
											</button>
											<button
												type="button"
												aria-label={`New thread with ${bot.name}`}
												className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-text-muted"
												onClick={() => onNewThread(bot.id)}
											>
												+
											</button>
										</div>
										<button
											type="button"
											aria-pressed={selected}
											onClick={() => onSelectBot(bot.id)}
											className="flex flex-col items-start gap-2 text-left"
										>
											<span className="w-fit max-w-full truncate rounded-full bg-bg px-1.5 font-mono text-[length:var(--fs-xs)] text-text-muted">
												{modelTag(bot.model)}
											</span>
											<span className="text-[length:var(--fs-xs)] text-text-muted">
												{botChats.length} threads
											</span>
										</button>
									</div>
								);
							})}
						</div>
					)}
					{menuBot ? (
						<GroupMenuSheet
							bot={menuBot}
							open={Boolean(menuBotId)}
							onOpenChange={(open) => {
								if (!open) setMenuBotId(null);
							}}
							openChatCount={
								openChats.filter((c) => c.botId === menuBot.id).length
							}
							onProfile={() => {
								setMenuBotId(null);
								void navigate({
									to: "/bot/$botId/$tab",
									params: { botId: menuBot.id, tab: "schedules" },
								});
							}}
							onNewChat={() => {
								setMenuBotId(null);
								onNewThread(menuBot.id);
							}}
							onArchived={() => {
								setMenuBotId(null);
							}}
						/>
					) : null}
				</div>
			</section>
			<section
				aria-label="Live thread feed"
				className="flex min-h-0 flex-1 flex-col overflow-hidden"
			>
				<div className="px-3 pt-3 pb-2">
					<h2 className="text-[length:var(--fs-xs)] font-semibold uppercase tracking-wide text-text-muted">
						Live thread feed
					</h2>
					<div className="mt-2 flex gap-1">
						{FILTERS.map((entry) => (
							<button
								key={entry.id}
								type="button"
								aria-pressed={filter === entry.id}
								onClick={() => onFilterChange(entry.id)}
								className={cn(
									"rounded-full px-2.5 py-1 text-[length:var(--fs-xs)] font-medium text-text-muted",
									filter === entry.id && "bg-surface text-text",
								)}
							>
								{entry.label}
							</button>
						))}
					</div>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto">
					{threads.length === 0 ? (
						<p className="px-3 py-4 text-[length:var(--fs-sm)] text-text-muted">
							No threads yet.
						</p>
					) : (
						<ul className="flex flex-col">
							{threads.map((chat) => {
								const state = chatStates[chat.key];
								const title = chatTitle(chat, state?.lastUserText);
								const when = state?.lastBotAt ?? chat.createdAt;
								const at = state?.lastBotAt;
								const seen = lastSeen[chat.key];
								const unread =
									at !== undefined && (seen === undefined || at > seen);
								const botName =
									bots.find((bot) => bot.id === chat.botId)?.name ?? chat.botId;
								const selected = chat.key === selectedChatKey;
								return (
									<li key={chat.key} className="border-b border-border">
										<div className="flex items-stretch">
											<button
												type="button"
												onClick={() => onSelectChat(chat.key, chat.botId)}
												className={cn(
													"flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left",
													selected && "bg-accent/10",
												)}
											>
												<StatusShape
													status={rowStatus({
														busy: state?.busy,
														failed: Boolean(state?.failedReason),
													})}
												/>
												<span className="min-w-0 flex-1">
													<span className="flex items-center gap-1.5">
														<span
															className={cn(
																"block truncate font-medium",
																unread && "font-semibold",
															)}
														>
															{title}
														</span>
														{unread ? <UnreadDot /> : null}
													</span>
													<span className="block truncate text-[length:var(--fs-xs)] text-text-muted">
														{botName}
													</span>
												</span>
												<span className="shrink-0 text-[length:var(--fs-xs)] text-text-muted">
													{formatRelative(when)}
												</span>
											</button>
											<button
												type="button"
												aria-label={`Archive ${title}`}
												className="shrink-0 px-2.5 text-[length:var(--fs-sm)] text-text-muted hover:text-text"
												onClick={(event) => {
													event.stopPropagation();
													void archiveChat(chat.key);
												}}
											>
												□
											</button>
											{state?.failedReason ? (
												<button
													type="button"
													className="shrink-0 px-3 text-[length:var(--fs-sm)] font-medium text-text"
													onClick={(event) => {
														event.stopPropagation();
														void retryChat(chat.key);
													}}
												>
													Retry
												</button>
											) : null}
										</div>
									</li>
								);
							})}
						</ul>
					)}
				</div>
			</section>
		</aside>
	);
}
