import type { TranscriptMessageView } from "@cadmus/contract/types";
import { Link } from "@tanstack/react-router";
import {
	ArrowLeft,
	ChevronDown,
	ChevronRight,
	FolderOpen,
	History,
	RotateCcw,
	Sparkles,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { BotBadge } from "@/components/BotBadge";
import { Composer } from "@/components/Composer";
import { AddEntityDialog } from "@/components/chrome/AddEntityDialog";
import { GroupChatViewerSheet } from "@/components/GroupChatViewerSheet";
import { LiveCard } from "@/components/LiveCard";
import { Markdown } from "@/components/Markdown";
import { ToolCallCard } from "@/components/ToolCallCard";
import { useCadmus } from "@/context/CadmusContext";
import { useAutoScroll } from "@/hooks/useAutoScroll";
import {
	compactionContextMetrics,
	countTurnsSincePreviousBoundary,
} from "@/lib/compaction-stream";
import { formatRelative } from "@/lib/format-time";
import type { GroupChatMessage } from "@/lib/group-chat-data";
import {
	groupToolRuns,
	type ToolRunMessage,
	type TranscriptItem,
} from "@/lib/group-tool-runs";
import { cn } from "@/lib/utils";
import { CadmusVfsDrawer } from "@/surfaces/user/CadmusVfsDrawer";

type StreamSegment =
	| { kind: "boundary"; message: TranscriptMessageView; index: number }
	| {
			kind: "item";
			item: TranscriptItem;
			visibleToModel: boolean;
	  };

function buildStreamSegments(
	messages: readonly TranscriptMessageView[],
): StreamSegment[] {
	const segments: StreamSegment[] = [];
	const visibilityById = new Map<number, boolean>();
	let buffer: ToolRunMessage[] = [];

	const flushBuffer = () => {
		if (buffer.length === 0) return;
		const grouped = groupToolRuns(buffer);
		for (const item of grouped) {
			const id = item.type === "tools" ? item.startId : item.message.id;
			const visibleToModel = visibilityById.get(id) ?? true;
			segments.push({ kind: "item", item, visibleToModel });
		}
		buffer = [];
	};

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (!msg) continue;
		if (msg.role === "compaction" || msg.role === "reset") {
			flushBuffer();
			segments.push({ kind: "boundary", message: msg, index: i });
		} else {
			visibilityById.set(msg.id, msg.visibleToModel !== false);
			buffer.push(msg as ToolRunMessage);
		}
	}
	flushBuffer();
	return segments;
}

export function BotStreamPage({ botId }: { botId: string }) {
	const {
		client,
		bots,
		chatStates,
		compactingChats,
		activeChat,
		loadBotChat,
		loadOlderMessages,
		markChatSeen,
		setLastBotId,
		queueTurn,
		noteUserText,
		retryChat,
	} = useCadmus();

	const bot = useMemo(() => bots.find((b) => b.id === botId), [bots, botId]);
	const chatKey = bot?.primaryChatKey ?? `bot:${botId}`;

	const [vfsOpen, setVfsOpen] = useState(false);
	const [resetOpen, setResetOpen] = useState(false);
	const [resetHandoff, setResetHandoff] = useState(true);
	const [resetBusy, setResetBusy] = useState(false);
	const [resetError, setResetError] = useState<string | null>(null);
	const [expandedBoundaries, setExpandedBoundaries] = useState<
		Record<string, boolean>
	>({});
	const [groupViewer, setGroupViewer] = useState<{
		open: boolean;
		topic?: string;
		status?: string;
		members?: string[];
		transcript?: GroupChatMessage[];
		response?: string;
	}>({ open: false });

	const messages = activeChat.chatKey === chatKey ? activeChat.messages : [];
	const entries = activeChat.chatKey === chatKey ? activeChat.entries : [];
	const notes = activeChat.chatKey === chatKey ? activeChat.notes : [];
	const hasMore = activeChat.chatKey === chatKey ? activeChat.hasMore : false;

	const live = chatStates[chatKey];
	const compacting = Boolean(
		compactingChats[chatKey] || live?.status?.compaction?.active,
	);
	const metrics = useMemo(
		() => compactionContextMetrics(live?.status?.compaction),
		[live?.status?.compaction],
	);

	const { scrollRef, handleScroll } = useAutoScroll({
		chatKey,
		streamingActive: Boolean(live?.busy),
	});

	useEffect(() => {
		setLastBotId(botId);
		void loadBotChat(chatKey);
	}, [botId, chatKey, loadBotChat, setLastBotId]);

	const messageCount = messages.length;
	useEffect(() => {
		if (messageCount >= 0) {
			markChatSeen(chatKey);
		}
	}, [chatKey, markChatSeen, messageCount]);

	const segments = useMemo(() => buildStreamSegments(messages), [messages]);

	function toggleBoundary(key: string) {
		setExpandedBoundaries((prev) => ({ ...prev, [key]: !prev[key] }));
	}

	async function handleReset(e: React.FormEvent) {
		e.preventDefault();
		setResetBusy(true);
		setResetError(null);
		const res = await client.callRpc("chat.reset", {
			chatKey,
			handoff: resetHandoff,
		});
		setResetBusy(false);
		if (!res.ok) {
			setResetError(res.error?.message ?? "Could not reset context window.");
			return;
		}
		setResetOpen(false);
		await loadBotChat(chatKey);
	}

	function handleSend(text: string, steer: boolean) {
		noteUserText(chatKey, text);
		queueTurn({
			chatKey,
			text,
			clientMsgId: crypto.randomUUID(),
			whenBusy: steer ? "steer" : "queue",
		});
	}

	if (!bot) {
		return (
			<div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
				<p className="text-sm font-medium text-text">Bot not found</p>
				<p className="mt-1 text-xs text-text-muted">
					Select a bot from your sidebar or create a new one.
				</p>
				<Link
					to="/bots"
					className="mt-4 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text hover:bg-surface-raised"
				>
					Back to bots
				</Link>
			</div>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 overflow-hidden">
			{/* Stream Canvas */}
			<div className="flex min-w-0 flex-1 flex-col">
				{/* Stream Header */}
				<header className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-surface px-3 py-2">
					<div className="flex min-w-0 items-center gap-2.5">
						<Link
							to="/bots"
							aria-label="Back to bots"
							className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-surface-raised hover:text-text md:hidden"
						>
							<ArrowLeft className="h-4 w-4" />
						</Link>
						<BotBadge bot={bot} className="size-8 shrink-0" />
						<div className="min-w-0">
							<h1 className="truncate text-sm font-semibold text-text">
								{bot.name}
							</h1>
							<p className="truncate font-mono text-[11px] text-text-muted">
								{bot.model}
							</p>
						</div>
					</div>

					<div className="flex shrink-0 items-center gap-1.5">
						{metrics.contextWindow > 0 ? (
							<div
								title={`${metrics.contextTokens.toLocaleString()} / ${metrics.contextWindow.toLocaleString()} tokens`}
								className={cn(
									"hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium sm:inline-flex",
									metrics.nearThreshold
										? "border-status-needs-you/40 bg-status-needs-you/12 text-status-needs-you"
										: "border-border bg-bg/60 text-text-muted",
								)}
							>
								<span className="tabular-nums">{metrics.usedPct}% ctx</span>
							</div>
						) : null}

						<button
							type="button"
							onClick={() => {
								setResetError(null);
								setResetOpen(true);
							}}
							aria-label="Reset context window"
							className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs font-medium text-text-muted hover:bg-surface-raised hover:text-text"
						>
							<RotateCcw className="h-3.5 w-3.5" />
							<span className="hidden sm:inline">Reset</span>
						</button>

						<button
							type="button"
							onClick={() => setVfsOpen((v) => !v)}
							aria-label="Toggle /.cadmus/ drawer"
							className={cn(
								"inline-flex h-9 items-center gap-1.5 rounded-lg border px-2.5 font-mono text-xs font-medium transition",
								vfsOpen
									? "border-accent bg-accent/15 text-accent"
									: "border-border text-text-muted hover:bg-surface-raised hover:text-text",
							)}
						>
							<FolderOpen className="h-3.5 w-3.5" />
							<span>/.cadmus/</span>
						</button>
					</div>
				</header>

				{/* Live Background Compaction Banner */}
				{compacting ? (
					<div
						role="status"
						className="flex shrink-0 items-center gap-2 border-b border-accent/30 bg-accent/10 px-4 py-1.5 text-xs text-accent"
					>
						<Sparkles className="h-3.5 w-3.5 shrink-0 animate-pulse" />
						<span>
							Compacting earlier turns in background… active replies stay
							unblocked.
						</span>
					</div>
				) : null}

				{/* Scrollable Transcript Stream */}
				<div
					ref={scrollRef}
					onScroll={handleScroll}
					className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-6"
				>
					<div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
						{hasMore ? (
							<div className="flex justify-center">
								<button
									type="button"
									disabled={activeChat.loadingOlder}
									onClick={() => void loadOlderMessages(chatKey)}
									className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3.5 py-1.5 text-xs font-medium text-text-muted hover:border-accent/40 hover:text-text disabled:opacity-50"
								>
									<History className="h-3.5 w-3.5" />
									{activeChat.loadingOlder
										? "Loading earlier history…"
										: "Load earlier history"}
								</button>
							</div>
						) : null}

						{segments.length === 0 && !live?.busy ? (
							<div className="my-12 rounded-2xl border border-dashed border-border bg-surface/50 p-6 text-center">
								<div className="mx-auto mb-3 flex justify-center">
									<BotBadge bot={bot} className="size-11" />
								</div>
								<h2 className="text-sm font-semibold text-text">
									Continuous stream with {bot.name}
								</h2>
								<p className="mx-auto mt-1 max-w-md text-xs text-text-muted">
									Every message stays in one continuous history. As context
									grows, Cadmus compacts older turns automatically into summary
									dividers without interrupting you.
								</p>
							</div>
						) : null}

						{segments.map((seg, idx) => {
							if (seg.kind === "boundary") {
								const msg = seg.message;
								if (msg.role === "compaction") {
									const boundaryKey = String(msg.id ?? idx);
									const expanded = Boolean(expandedBoundaries[boundaryKey]);
									const summarizedTurns = countTurnsSincePreviousBoundary(
										messages,
										seg.index,
									);
									return (
										<div
											key={boundaryKey}
											className="my-2 rounded-xl border border-accent/30 bg-accent/8 px-3 py-2"
										>
											<button
												type="button"
												onClick={() => toggleBoundary(boundaryKey)}
												aria-expanded={expanded}
												className="flex w-full items-center justify-between gap-2 text-left text-xs font-medium text-accent"
											>
												<span className="inline-flex items-center gap-1.5">
													<Sparkles className="h-3.5 w-3.5 shrink-0" />
													<span>
														Compacted earlier context
														{summarizedTurns > 0
															? ` · ${summarizedTurns} user ${summarizedTurns === 1 ? "turn" : "turns"}`
															: ""}
													</span>
												</span>
												<span className="inline-flex items-center gap-1 text-[11px] opacity-80">
													{expanded ? "Hide summary" : "View summary"}
													{expanded ? (
														<ChevronDown className="h-3.5 w-3.5" />
													) : (
														<ChevronRight className="h-3.5 w-3.5" />
													)}
												</span>
											</button>
											{expanded ? (
												<div className="mt-2 border-t border-accent/20 pt-2 text-xs text-text">
													{msg.firstKeptEntryId !== undefined ? (
														<div className="mb-1.5 font-mono text-[10px] text-text-muted">
															Kept from entry #{msg.firstKeptEntryId}
														</div>
													) : null}
													<Markdown
														source={msg.text || "Compaction summary recorded."}
													/>
												</div>
											) : null}
										</div>
									);
								}

								return (
									<div
										key={String(msg.id ?? idx)}
										className="my-2 flex items-center gap-3 text-[11px] text-text-muted"
									>
										<div className="h-px flex-1 bg-border" />
										<span className="rounded-full border border-border bg-surface px-2.5 py-0.5 font-medium">
											{msg.text || "Context window reset"}
											{msg.timestamp
												? ` · ${formatRelative(msg.timestamp)}`
												: ""}
										</span>
										<div className="h-px flex-1 bg-border" />
									</div>
								);
							}

							const { item, visibleToModel } = seg;
							if (item.type === "tools") {
								return (
									<div
										key={`tools-${item.startId}`}
										className={cn(
											"space-y-1.5",
											!visibleToModel && "opacity-75",
										)}
									>
										{item.calls.map((call) => (
											<ToolCallCard
												key={call.id}
												call={call}
												bots={bots}
												onOpenGroupChat={(data) =>
													setGroupViewer({ open: true, ...data })
												}
											/>
										))}
									</div>
								);
							}

							if (item.type === "user") {
								return (
									<div
										key={item.message.id}
										className={cn(
											"flex justify-end",
											!visibleToModel && "opacity-75",
										)}
									>
										<div className="max-w-[85%] rounded-2xl rounded-br-sm border border-accent/30 bg-accent/15 px-3.5 py-2.5 text-sm text-text">
											<p className="whitespace-pre-wrap">{item.message.text}</p>
										</div>
									</div>
								);
							}

							return (
								<div
									key={item.message.id}
									className={cn(
										"flex justify-start",
										!visibleToModel && "opacity-80",
									)}
								>
									<div className="min-w-0 max-w-[92%] rounded-2xl rounded-bl-sm border border-border bg-surface px-4 py-3 text-sm text-text">
										<Markdown source={item.message.text} />
									</div>
								</div>
							);
						})}

						{live?.busy ? (
							<LiveCard
								title={
									live.activeTool
										? `Running ${live.activeTool.toolName}…`
										: "Thinking…"
								}
								onStop={() => {
									void client.callRpc("turn.interrupt", { chatKey });
								}}
							>
								{live.streamText ? <Markdown source={live.streamText} /> : null}
							</LiveCard>
						) : null}

						{live?.failedReason ? (
							<div
								role="alert"
								className="flex items-center justify-between gap-3 rounded-xl border border-status-failed/40 bg-status-failed/10 px-3.5 py-2.5 text-xs text-status-failed"
							>
								<span className="min-w-0 flex-1">{live.failedReason}</span>
								<button
									type="button"
									onClick={() => void retryChat(chatKey)}
									className="shrink-0 rounded-md border border-status-failed/40 px-2.5 py-1 font-semibold hover:bg-status-failed/15"
								>
									Retry
								</button>
							</div>
						) : null}
					</div>
				</div>

				{/* Composer */}
				<div className="mx-auto w-full max-w-3xl shrink-0">
					<Composer
						placeholder={`Message ${bot.name}…`}
						steerEnabled={Boolean(live?.busy)}
						onSend={handleSend}
					/>
				</div>
			</div>

			{/* Slide-over /.cadmus/ VFS Drawer */}
			<CadmusVfsDrawer
				open={vfsOpen}
				onClose={() => setVfsOpen(false)}
				bot={bot}
				entries={entries}
				notes={notes}
			/>

			{/* Reset Context Window Modal */}
			<AddEntityDialog
				open={resetOpen}
				onClose={() => setResetOpen(false)}
				title={`Reset ${bot.name} context?`}
				description="Inserts a reset divider and starts a fresh active context window while keeping all prior history visible."
			>
				<form onSubmit={(e) => void handleReset(e)} className="space-y-4">
					{resetError ? (
						<p role="alert" className="text-xs text-destructive">
							{resetError}
						</p>
					) : null}
					<label className="flex items-start gap-2.5 rounded-lg border border-border bg-bg/60 p-3 text-xs">
						<input
							type="checkbox"
							checked={resetHandoff}
							onChange={(e) => setResetHandoff(e.target.checked)}
							className="mt-0.5"
						/>
						<span>
							<strong className="block text-text">
								Generate handoff summary
							</strong>
							<span className="text-text-muted">
								Summarizes key open threads before starting the fresh context
								window.
							</span>
						</span>
					</label>
					<div className="flex justify-end gap-2">
						<button
							type="button"
							onClick={() => setResetOpen(false)}
							className="min-h-tap rounded-lg border border-border px-4 text-xs text-text-muted"
						>
							Cancel
						</button>
						<button
							type="submit"
							disabled={resetBusy}
							className="min-h-tap rounded-lg bg-accent px-4 text-xs font-semibold text-on-accent disabled:opacity-50"
						>
							{resetBusy ? "Resetting…" : "Reset context"}
						</button>
					</div>
				</form>
			</AddEntityDialog>

			<GroupChatViewerSheet
				open={groupViewer.open}
				onOpenChange={(open) => setGroupViewer((prev) => ({ ...prev, open }))}
				topic={groupViewer.topic}
				status={groupViewer.status}
				members={groupViewer.members}
				transcript={groupViewer.transcript}
				response={groupViewer.response}
				bots={bots}
			/>
		</div>
	);
}
