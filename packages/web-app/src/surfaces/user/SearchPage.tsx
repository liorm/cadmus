import { Link } from "@tanstack/react-router";
import { Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { BotBadge } from "@/components/BotBadge";
import { HighlightedText } from "@/components/HighlightedText";
import { useCadmus } from "@/context/CadmusContext";
import { formatRelative } from "@/lib/format-time";
import { matchRanges } from "@/lib/match-ranges";
import { UserShell } from "@/surfaces/user/UserShell";

export function SearchPage() {
	const { bots, chats, chatStates } = useCadmus();
	const [query, setQuery] = useState("");
	const trimmed = query.trim();

	const matches = useMemo(() => {
		if (!trimmed) return [];
		return bots
			.map((bot) => {
				const chat =
					chats.find((c) => c.key === bot.primaryChatKey) ??
					chats.find((c) => c.botId === bot.id);
				const lastText = chatStates[bot.primaryChatKey]?.lastUserText ?? "";
				const haystack = [bot.name, bot.model, chat?.title ?? "", lastText]
					.filter(Boolean)
					.join(" · ");
				const hits = matchRanges(haystack, trimmed);
				return hits.length > 0 ? { bot, chat, haystack } : null;
			})
			.filter((item): item is NonNullable<typeof item> => item !== null);
	}, [bots, chatStates, chats, trimmed]);

	return (
		<UserShell activeTab="search" mobileTitle="Search">
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
				<header className="border-b border-border bg-surface px-4 py-3 sm:px-6">
					<div className="mx-auto flex max-w-3xl items-center gap-2 rounded-xl border border-accent/60 bg-bg px-3 py-2">
						<Search className="h-4 w-4 text-text-muted" />
						<input
							aria-label="Search bots and streams"
							placeholder="Search bots, models, or recent messages…"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							className="min-w-0 flex-1 bg-transparent text-sm text-text outline-none"
						/>
						{query ? (
							<button
								type="button"
								aria-label="Clear search"
								onClick={() => setQuery("")}
								className="text-text-muted hover:text-text"
							>
								<X className="h-4 w-4" />
							</button>
						) : null}
					</div>
				</header>

				<div className="mx-auto w-full max-w-3xl flex-1 p-4 sm:p-6">
					{!trimmed ? (
						<p className="py-12 text-center text-xs text-text-muted">
							Type a bot name, model id, or recent prompt snippet to jump
							straight into its continuous stream.
						</p>
					) : matches.length === 0 ? (
						<p className="py-12 text-center text-xs text-text-muted">
							No bots matched &ldquo;{trimmed}&rdquo;.
						</p>
					) : (
						<ul className="space-y-2">
							{matches.map(({ bot, chat, haystack }) => (
								<li key={bot.id}>
									<Link
										to="/bot/$botId"
										params={{ botId: bot.id }}
										className="flex items-center gap-3 rounded-xl border border-border bg-surface p-3 transition hover:border-accent/50 hover:bg-surface-raised"
									>
										<BotBadge bot={bot} className="size-9 shrink-0" />
										<div className="min-w-0 flex-1">
											<div className="flex items-center justify-between gap-2">
												<span className="truncate text-sm font-semibold text-text">
													<HighlightedText text={bot.name} query={trimmed} />
												</span>
												<span className="shrink-0 text-[11px] text-text-muted">
													{chat?.createdAt
														? formatRelative(chat.createdAt)
														: ""}
												</span>
											</div>
											<div className="mt-0.5 truncate text-xs text-text-muted">
												<HighlightedText text={haystack} query={trimmed} />
											</div>
										</div>
									</Link>
								</li>
							))}
						</ul>
					)}
				</div>
			</div>
		</UserShell>
	);
}
