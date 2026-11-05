import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { BotBadge } from "@/components/BotBadge";
import { BotChip } from "@/components/BotChip";
import { Composer } from "@/components/Composer";
import { HighlightedText } from "@/components/HighlightedText";
import { rowStatus, StatusShape } from "@/components/StatusShape";
import { UnreadDot } from "@/components/UnreadDot";
import { useCadmus } from "@/context/CadmusContext";
import { botColor, botColorVar } from "@/lib/bot-color";
import { chatTitle, formatRelative } from "@/lib/format-time";
import { matchRanges } from "@/lib/match-ranges";
import { cn } from "@/lib/utils";

const SEARCH_DEBOUNCE_MS = 200;

export function SearchPage() {
	const navigate = useNavigate();
	const {
		bots,
		chats,
		chatStates,
		lastSeen,
		lastBotId,
		setLastBotId,
		createChatAndSubmit,
	} = useCadmus();
	const inputRef = useRef<HTMLInputElement>(null);
	const [raw, setRaw] = useState("");
	const [query, setQuery] = useState("");
	const [selectedBot, setSelectedBot] = useState(
		() => lastBotId ?? bots[0]?.id ?? "",
	);
	const botId = bots.some((bot) => bot.id === selectedBot)
		? selectedBot
		: lastBotId && bots.some((bot) => bot.id === lastBotId)
			? lastBotId
			: (bots[0]?.id ?? "");

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	useEffect(() => {
		const timer = window.setTimeout(
			() => setQuery(raw.trim()),
			SEARCH_DEBOUNCE_MS,
		);
		return () => window.clearTimeout(timer);
	}, [raw]);

	const groups = useMemo(() => {
		if (!query) return [];
		return bots
			.map((bot) => ({
				bot,
				chats: chats
					.filter((chat) => chat.botId === bot.id)
					.filter(
						(chat) =>
							matchRanges(
								chatTitle(chat, chatStates[chat.key]?.lastUserText),
								query,
							).length > 0,
					)
					.sort((a, b) => b.createdAt - a.createdAt),
			}))
			.filter((group) => group.chats.length > 0);
	}, [bots, chatStates, chats, query]);

	const matchCount = groups.reduce((sum, group) => sum + group.chats.length, 0);

	return (
		<AppShell
			title="Search"
			showBack={false}
			header={
				<div className="flex items-center gap-2 border-b border-border px-3 py-2">
					<div className="flex min-h-tap min-w-0 flex-1 items-center gap-2 rounded-lg border border-accent bg-surface px-3">
						<span aria-hidden="true" className="text-text-muted">
							⌕
						</span>
						<input
							ref={inputRef}
							aria-label="Search"
							placeholder="Search"
							value={raw}
							onChange={(event) => setRaw(event.target.value)}
							className="min-w-0 flex-1 bg-transparent py-2 text-[length:var(--fs-md)] outline-none"
						/>
						{raw ? (
							<button
								type="button"
								aria-label="Clear search"
								className="inline-flex min-h-tap min-w-tap items-center justify-center text-text-muted"
								onClick={() => setRaw("")}
							>
								×
							</button>
						) : null}
					</div>
					<button
						type="button"
						className="min-h-tap px-1 font-medium text-accent"
						onClick={() => void navigate({ to: "/" })}
					>
						Cancel
					</button>
				</div>
			}
		>
			<div className="flex min-h-0 flex-1 flex-col">
				<div className="min-h-0 flex-1 overflow-y-auto px-3 pt-3">
					{query ? (
						<p
							role="status"
							className="mb-2 text-[length:var(--fs-xs)] font-semibold uppercase tracking-wide text-text-muted"
						>
							{matchCount} {matchCount === 1 ? "chat" : "chats"} match
						</p>
					) : null}
					<div className="flex flex-col gap-3">
						{groups.map(({ bot, chats: groupChats }) => {
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
												<BotBadge
													bot={bot}
													className="size-8 min-h-0 min-w-0"
												/>
												<span className="truncate font-semibold">
													{bot.name}
												</span>
											</header>
											{groupChats.map((chat) => {
												const state = chatStates[chat.key];
												const title = chatTitle(chat, state?.lastUserText);
												const unread =
													state?.lastBotAt !== undefined &&
													(lastSeen[chat.key] === undefined ||
														state.lastBotAt > (lastSeen[chat.key] ?? 0));
												const when = state?.lastBotAt ?? chat.createdAt;
												return (
													<div
														key={chat.key}
														className="flex min-h-tap items-center gap-2 border-t border-border px-3"
													>
														<StatusShape
															status={rowStatus({
																busy: state?.busy,
																failed: Boolean(state?.failedReason),
															})}
														/>
														<button
															type="button"
															aria-label={title}
															className={cn(
																"min-w-0 flex-1 py-2 text-left",
																unread ? "font-semibold" : "",
															)}
															onClick={() =>
																navigate({
																	to: "/chat/$chatKey",
																	params: { chatKey: chat.key },
																	search: { view: "chat" },
																})
															}
														>
															<div className="truncate">
																<HighlightedText text={title} query={query} />
															</div>
														</button>
														{unread ? <UnreadDot /> : null}
														<span className="text-[length:var(--fs-xs)] text-text-muted">
															{formatRelative(when)}
														</span>
													</div>
												);
											})}
										</div>
									</div>
								</section>
							);
						})}
					</div>
					<p className="py-6 text-center text-[length:var(--fs-sm)] text-text-muted">
						Searching chat titles
					</p>
				</div>
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
						if (!botId) return;
						void createChatAndSubmit(botId, text);
					}}
				/>
			</div>
		</AppShell>
	);
}
