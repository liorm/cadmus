import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { BotBadge } from "@/components/BotBadge";
import { BotChip } from "@/components/BotChip";
import { Composer } from "@/components/Composer";
import { GroupMenuSheet } from "@/components/GroupMenuSheet";
import { rowStatus, StatusShape } from "@/components/StatusShape";
import { SwipeRow } from "@/components/SwipeRow";
import { UnreadDot } from "@/components/UnreadDot";
import { Button } from "@/components/ui/button";
import { useCadmus } from "@/context/CadmusContext";
import { botColor, botColorVar } from "@/lib/bot-color";
import { chatTitle, formatRelative } from "@/lib/format-time";
import { needsYou } from "@/lib/needs-you";
import { cn } from "@/lib/utils";

const NEEDS_CAP = 3;

export function HomePage() {
	const navigate = useNavigate();
	const {
		bots,
		chats,
		chatStates,
		lastSeen,
		collapsed,
		lastBotId,
		directoryReady,
		toggleCollapsed,
		setLastBotId,
		archiveChat,
		retryChat,
		createChatAndSubmit,
	} = useCadmus();
	const [needsExpanded, setNeedsExpanded] = useState(false);
	const [toast, setToast] = useState<string | null>(null);
	const [menuBotId, setMenuBotId] = useState<string | null>(null);
	const [selectedBot, setSelectedBot] = useState(
		() => lastBotId ?? bots[0]?.id ?? "",
	);
	const botId = bots.some((bot) => bot.id === selectedBot)
		? selectedBot
		: lastBotId && bots.some((bot) => bot.id === lastBotId)
			? lastBotId
			: (bots[0]?.id ?? "");

	const items = useMemo(
		() => needsYou(chats, chatStates, lastSeen),
		[chats, chatStates, lastSeen],
	);
	const shownNeeds = needsExpanded ? items : items.slice(0, NEEDS_CAP);

	async function sendFromHome(text: string) {
		if (!botId) return;
		await createChatAndSubmit(botId, text);
	}

	return (
		<AppShell
			title="Cadmus"
			showBack={false}
			actions={
				<>
					<Link
						to="/search"
						aria-label="Search"
						className="inline-flex min-h-tap min-w-tap items-center justify-center"
					>
						⌕
					</Link>
					<Link
						to="/settings"
						aria-label="Settings"
						className="inline-flex min-h-tap min-w-tap items-center justify-center"
					>
						⚙
					</Link>
				</>
			}
		>
			<div className="flex min-h-0 flex-1 flex-col">
				<div className="min-h-0 flex-1 overflow-y-auto pb-2">
					{directoryReady && bots.length === 0 ? (
						<div className="flex h-full flex-col items-center justify-center px-8 text-center">
							<div
								aria-hidden="true"
								className="mb-6 flex size-20 items-center justify-center rounded-2xl border border-border bg-surface text-[length:var(--fs-lg)] tracking-[0.4em] text-text-muted"
							>
								···
							</div>
							<h2 className="text-[length:var(--fs-lg)] font-semibold">
								It's quiet in here.
							</h2>
							<p className="mt-2 max-w-xs text-[length:var(--fs-sm)] text-text-muted">
								So quiet you can hear the crickets. No bots, no tasks yet.
								Create your first bot, then give it something to do below.
							</p>
							<Button asChild className="mt-6 rounded-full px-5">
								<Link to="/bot/new">+ New bot</Link>
							</Button>
						</div>
					) : null}
					{items.length > 0 ? (
						<section aria-labelledby="needs-you-heading" className="px-3 pt-3">
							<h2
								id="needs-you-heading"
								className="mb-2 flex items-center gap-2 text-[length:var(--fs-xs)] font-semibold uppercase tracking-wide text-status-needs-you"
							>
								<StatusShape status="needs-you" />
								Needs you · {items.length}
							</h2>
							<div className="tint-needs overflow-hidden rounded-md border border-status-needs-you/40">
								{shownNeeds.map((item) => {
									const bot = bots.find((entry) => entry.id === item.botId);
									return (
										<div
											key={`${item.kind}-${item.chatKey}`}
											className="flex min-h-tap items-center gap-2 border-b border-status-needs-you/20 px-3 last:border-b-0"
										>
											{item.kind === "failed" ? (
												<StatusShape status="failed" />
											) : bot ? (
												<BotBadge
													bot={bot}
													className="size-7 min-h-0 min-w-0 text-[length:var(--fs-xs)]"
												/>
											) : (
												<UnreadDot />
											)}
											<button
												type="button"
												className="min-w-0 flex-1 py-2 text-left"
												onClick={() =>
													navigate({
														to: "/chat/$chatKey",
														params: { chatKey: item.chatKey },
														search: { view: "chat" },
													})
												}
											>
												<div className="truncate font-semibold">
													{item.title}
												</div>
												<div className="truncate text-[length:var(--fs-sm)] text-text-muted">
													{item.kind === "failed" ? item.reason : item.preview}
												</div>
											</button>
											{item.kind === "unread" ? <UnreadDot /> : null}
											<span className="text-[length:var(--fs-xs)] text-text-muted">
												{formatRelative(item.at)}
											</span>
											{item.kind === "failed" ? (
												<Button
													variant="ghost"
													className="border border-border bg-bg px-3"
													onClick={() => void retryChat(item.chatKey)}
												>
													Retry
												</Button>
											) : null}
										</div>
									);
								})}
								{items.length > NEEDS_CAP ? (
									<button
										type="button"
										className="flex min-h-tap w-full items-center justify-center text-[length:var(--fs-sm)] font-medium text-status-needs-you"
										onClick={() => setNeedsExpanded((open) => !open)}
									>
										{needsExpanded ? "Show less" : `Show all ${items.length} ›`}
									</button>
								) : null}
							</div>
						</section>
					) : null}

					{bots.length === 0 ? null : (
						<nav aria-label="Bots" className="flex flex-col gap-3 px-3 pt-4">
							<p className="text-[length:var(--fs-xs)] font-semibold uppercase tracking-wide text-text-muted">
								Bots
							</p>
							{bots.map((bot) => {
								const groupChats = chats
									.filter((chat) => chat.botId === bot.id)
									.sort((a, b) => b.createdAt - a.createdAt);
								const isCollapsed = Boolean(collapsed[bot.id]);
								const unread = groupChats.some((chat) => {
									const at = chatStates[chat.key]?.lastBotAt;
									const seen = lastSeen[chat.key];
									return at !== undefined && (seen === undefined || at > seen);
								});
								const running = groupChats.filter(
									(chat) => chatStates[chat.key]?.busy,
								).length;
								const failed = groupChats.filter(
									(chat) => chatStates[chat.key]?.failedReason,
								).length;
								const idle = running === 0 && failed === 0 && !unread;
								const statusText = running
									? `${running} running`
									: failed
										? `${failed} failed`
										: unread
											? `${groupChats.length} active`
											: undefined;
								const slot = botColor(bot);
								return (
									<section
										key={bot.id}
										aria-label={bot.name}
										className="overflow-hidden rounded-md border border-border bg-surface"
									>
										<div className="flex">
											<div
												aria-hidden="true"
												className="w-1 shrink-0"
												style={{ background: botColorVar(slot) }}
											/>
											<div className="min-w-0 flex-1">
												<header className="flex min-h-tap items-center gap-2 px-3">
													<button
														type="button"
														className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left"
														aria-label={bot.name}
														aria-expanded={!isCollapsed}
														onClick={() => toggleCollapsed(bot.id)}
													>
														<BotBadge
															bot={bot}
															className="size-8 min-h-0 min-w-0"
														/>
														<span className="truncate font-semibold">
															{bot.name}
														</span>
														{unread ? <UnreadDot /> : null}
														{idle ? null : statusText ? (
															<span className="truncate text-[length:var(--fs-sm)] text-text-muted">
																{statusText}
															</span>
														) : null}
													</button>
													<button
														type="button"
														aria-label={`${bot.name} menu`}
														className="inline-flex min-h-tap min-w-tap items-center justify-center text-text-muted"
														onClick={() => setMenuBotId(bot.id)}
													>
														⋯
													</button>
													<button
														type="button"
														aria-label={
															isCollapsed
																? `Expand ${bot.name}`
																: `Collapse ${bot.name}`
														}
														onClick={() => toggleCollapsed(bot.id)}
														className="inline-flex min-h-tap min-w-tap items-center justify-center text-text-muted"
													>
														{isCollapsed ? "›" : "▾"}
													</button>
												</header>
												{isCollapsed
													? null
													: groupChats.map((chat) => {
															const state = chatStates[chat.key];
															const title = chatTitle(
																chat,
																state?.lastUserText,
															);
															const unreadRow =
																state?.lastBotAt !== undefined &&
																(lastSeen[chat.key] === undefined ||
																	state.lastBotAt > (lastSeen[chat.key] ?? 0));
															const status = rowStatus({
																busy: state?.busy,
																failed: Boolean(state?.failedReason),
															});
															const when = state?.lastBotAt ?? chat.createdAt;
															return (
																<SwipeRow
																	key={chat.key}
																	archiveLabel={`Archive chat ${title}`}
																	onArchive={() => {
																		void archiveChat(chat.key).then(() => {
																			setToast("Archived");
																			window.setTimeout(
																				() => setToast(null),
																				2000,
																			);
																		});
																	}}
																>
																	<div className="flex min-h-tap items-center gap-2 border-t border-border px-3">
																		<StatusShape status={status} />
																		<button
																			type="button"
																			aria-label={title}
																			className={cn(
																				"min-w-0 flex-1 py-2 text-left",
																				unreadRow ? "font-semibold" : "",
																			)}
																			onClick={() =>
																				navigate({
																					to: "/chat/$chatKey",
																					params: { chatKey: chat.key },
																					search: { view: "chat" },
																				})
																			}
																		>
																			<div className="truncate">{title}</div>
																			{state?.failedReason ? (
																				<div className="truncate text-[length:var(--fs-sm)] text-text-muted">
																					{state.failedReason}
																				</div>
																			) : null}
																		</button>
																		{unreadRow ? <UnreadDot /> : null}
																		<span className="text-[length:var(--fs-xs)] text-text-muted">
																			{formatRelative(when)}
																		</span>
																		{state?.failedReason ? (
																			<Button
																				variant="ghost"
																				className="border border-border px-3"
																				onClick={() => void retryChat(chat.key)}
																			>
																				Retry
																			</Button>
																		) : null}
																	</div>
																</SwipeRow>
															);
														})}
											</div>
										</div>
									</section>
								);
							})}
							<Link
								to="/bot/new"
								className="flex min-h-tap items-center justify-center rounded-md border border-dashed border-border text-[length:var(--fs-md)] text-text-muted"
							>
								+ New bot
							</Link>
						</nav>
					)}
				</div>
				{menuBotId ? (
					<GroupMenuSheet
						bot={
							bots.find((entry) => entry.id === menuBotId) ?? {
								id: menuBotId,
								name: menuBotId,
								model: "",
								thinking: "off",
								timezone: "UTC",
								rootConversationId: 0,
								createdAt: 0,
							}
						}
						openChatCount={
							chats.filter((chat) => chat.botId === menuBotId).length
						}
						open={Boolean(menuBotId)}
						onOpenChange={(open) => {
							if (!open) setMenuBotId(null);
						}}
						onProfile={() => {
							const id = menuBotId;
							setMenuBotId(null);
							void navigate({
								to: "/bot/$botId/$tab",
								params: { botId: id, tab: "schedules" },
							});
						}}
						onNewChat={() => {
							const id = menuBotId;
							setMenuBotId(null);
							void navigate({ to: "/new", search: { bot: id } });
						}}
						onArchived={() => {
							setToast("Archived");
							window.setTimeout(() => setToast(null), 2000);
						}}
					/>
				) : null}
				{toast ? (
					<p
						role="status"
						className="px-4 text-[length:var(--fs-sm)] text-text-muted"
					>
						{toast}
					</p>
				) : null}
				<Composer
					placeholder="Give a bot something to do..."
					disabled={!botId}
					onExpand={() =>
						navigate({
							to: "/new",
							search: botId ? { bot: botId } : {},
						})
					}
					leading={
						<BotChip
							bots={bots}
							value={botId}
							onChange={(id) => {
								setSelectedBot(id);
								setLastBotId(id);
							}}
							disabled={bots.length === 0}
						/>
					}
					onSend={(text) => {
						void sendFromHome(text);
					}}
				/>
			</div>
		</AppShell>
	);
}
