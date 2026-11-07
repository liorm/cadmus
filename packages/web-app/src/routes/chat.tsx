import type {
	ChatRecord,
	ChatTask,
	RawTranscriptEntry,
	TranscriptMessageView,
} from "@cadmus/contract/types";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { BotBadge } from "@/components/BotBadge";
import { BotPill } from "@/components/BotChip";
import { ChatMenuSheet } from "@/components/ChatMenuSheet";
import { ChatStatusIndicator } from "@/components/ChatStatusIndicator";
import { Composer } from "@/components/Composer";
import { InlineEditTitle } from "@/components/InlineEditTitle";
import { LiveCard } from "@/components/LiveCard";
import { Markdown } from "@/components/Markdown";
import { RawTranscript } from "@/components/RawTranscript";
import { SegmentedControl } from "@/components/SegmentedControl";
import { LoadError, SkeletonBlock } from "@/components/Skeleton";
import { StatusShape } from "@/components/StatusShape";
import { useCadmus } from "@/context/CadmusContext";
import { isNearBottom, useAutoScroll } from "@/hooks/useAutoScroll";
import { chatTitle } from "@/lib/format-time";
import { groupToolRuns } from "@/lib/group-tool-runs";
import type { LoadPhase } from "@/lib/load-state";
import { taskProgress } from "@/lib/task-progress";

function userTextCounts(
	messages: TranscriptMessageView[],
): Map<string, number> {
	const counts = new Map<string, number>();
	for (const message of messages) {
		if (message.role !== "user") continue;
		counts.set(message.text, (counts.get(message.text) ?? 0) + 1);
	}
	return counts;
}

function mergeServerMessages(
	server: TranscriptMessageView[],
	pending: TranscriptMessageView[],
	known: Map<string, number>,
): {
	messages: TranscriptMessageView[];
	pending: TranscriptMessageView[];
	known: Map<string, number>;
} {
	const fresh = userTextCounts(server);
	const unseen = new Map(fresh);
	for (const [text, count] of known) {
		unseen.set(text, Math.max(0, (unseen.get(text) ?? 0) - count));
	}
	const still: TranscriptMessageView[] = [];
	for (const message of pending) {
		const left = unseen.get(message.text) ?? 0;
		if (left > 0) {
			unseen.set(message.text, left - 1);
			continue;
		}
		still.push(message);
	}
	return {
		messages: still.length > 0 ? [...server, ...still] : server,
		pending: still,
		known: fresh,
	};
}

export function ChatPage({ view }: { view: "chat" | "raw" }) {
	const { chatKey } = useParams({ from: "/chat/$chatKey" });
	const navigate = useNavigate();
	const {
		client,
		bots,
		chats,
		chatStates,
		connectionStatus,
		markChatSeen,
		noteUserText,
		markFailed,
		refreshDirectory,
		refreshChatStatus,
		archiveChat,
		queueTurn,
	} = useCadmus();
	const chat = chats.find((entry) => entry.key === chatKey);
	const live = chatStates[chatKey];
	const [localBusy, setLocalBusy] = useState(false);
	// Bumped on Stop so an in-flight chat.get cannot restore Working.
	const localBusyEpoch = useRef(0);
	const ignoreStaleBusy = useRef(false);
	const busy = localBusy || Boolean(live?.busy);
	const [messages, setMessages] = useState<TranscriptMessageView[]>([]);
	const pendingOptimistic = useRef<TranscriptMessageView[]>([]);
	const knownUserTexts = useRef(new Map<string, number>());
	const [tasks, setTasks] = useState<ChatTask[]>([]);
	const [queued, setQueued] = useState<string[]>([]);
	const [steerOn, setSteerOn] = useState(false);
	const [collapsed, setCollapsed] = useState(false);
	const [liveInView, setLiveInView] = useState(true);
	const [newFromId, setNewFromId] = useState<number | null>(null);
	const [newCount, setNewCount] = useState(0);
	const [record, setRecord] = useState<ChatRecord | null>(null);
	const [entries, setEntries] = useState<RawTranscriptEntry[]>([]);
	const [transcriptPhase, setTranscriptPhase] = useState<LoadPhase>("loading");
	const [transcriptError, setTranscriptError] = useState<string | null>(null);
	const [rawPhase, setRawPhase] = useState<LoadPhase>("loading");
	const [rawError, setRawError] = useState<string | null>(null);
	const [loadAttempt, setLoadAttempt] = useState(0);
	const [menuOpen, setMenuOpen] = useState(false);
	const [renaming, setRenaming] = useState(false);
	const bot = bots.find((entry) => entry.id === (record ?? chat)?.botId);
	const liveRef = useRef<HTMLDivElement | null>(null);

	const { scrollRef, handleScroll, scrollToBottom } = useAutoScroll({
		chatKey,
		streamingActive: busy,
		hasNewUserMessage: queued.length > 0,
	});

	const applyServerMessages = useCallback((server: TranscriptMessageView[]) => {
		const merged = mergeServerMessages(
			server,
			pendingOptimistic.current,
			knownUserTexts.current,
		);
		pendingOptimistic.current = merged.pending;
		knownUserTexts.current = merged.known;
		setMessages(merged.messages);
	}, []);

	useEffect(() => {
		pendingOptimistic.current = [];
		knownUserTexts.current = new Map();
		void loadAttempt;
		const previous = markChatSeen(chatKey);
		let cancelled = false;
		setTranscriptPhase("loading");
		setTranscriptError(null);
		setMessages([]);
		setRecord(null);
		void (async () => {
			const busyEpoch = localBusyEpoch.current;
			const res = await client.callRpc<{
				chat: ChatRecord;
				messages: TranscriptMessageView[];
				busy: boolean;
				tasks?: ChatTask[];
			}>("chat.get", { chatKey });
			if (cancelled) return;
			if (!res.ok || !res.result) {
				setTranscriptPhase("error");
				setTranscriptError(res.error?.message ?? "Could not load chat");
				return;
			}
			setRecord(res.result.chat);
			applyServerMessages(res.result.messages);
			if (localBusyEpoch.current === busyEpoch) {
				setLocalBusy(Boolean(res.result.busy));
			}
			setTranscriptPhase("ready");
			if (res.result.tasks) setTasks(res.result.tasks);
			const listed = await client.callRpc<{ tasks: ChatTask[] }>(
				"chat.tasks.list",
				{ chatKey },
			);
			if (!cancelled && listed.ok && listed.result?.tasks) {
				setTasks(listed.result.tasks);
			}
			const seenAt = previous ?? 0;
			const fresh = res.result.messages.filter((message) => {
				if (message.role !== "assistant") return false;
				const ts = message.timestamp;
				return ts !== undefined && ts > seenAt;
			});
			if (fresh.length > 0) {
				setNewCount(fresh.length);
				setNewFromId(fresh[0]?.id ?? null);
			}
			await client.callRpc("chat.subscribe", { chatKey });
			await refreshChatStatus(chatKey);
		})().catch((err: unknown) => {
			if (cancelled) return;
			setTranscriptPhase("error");
			setTranscriptError(
				err instanceof Error ? err.message : "Could not load chat",
			);
		});
		return () => {
			cancelled = true;
		};
	}, [
		applyServerMessages,
		chatKey,
		client,
		loadAttempt,
		markChatSeen,
		refreshChatStatus,
	]);

	useEffect(() => {
		return client.subscribe((event) => {
			if ("payload" in event && event.payload && "chatKey" in event.payload) {
				const key = (event.payload as { chatKey?: string }).chatKey;
				if (key !== chatKey) return;
			} else {
				return;
			}
			if (event.type === "chat.state") {
				if (event.payload.busy && ignoreStaleBusy.current) return;
				if (!event.payload.busy) ignoreStaleBusy.current = false;
				setLocalBusy(event.payload.busy);
			}
			if (event.type === "turn.completed") {
				ignoreStaleBusy.current = false;
				setLocalBusy(false);
				void client
					.callRpc<{
						messages: TranscriptMessageView[];
						entries?: RawTranscriptEntry[];
					}>("chat.get", { chatKey })
					.then((res) => {
						if (res.ok && res.result?.messages)
							applyServerMessages(res.result.messages);
						if (res.ok && res.result?.entries) setEntries(res.result.entries);
					});
				setQueued((prev) => prev.slice(1));
				markChatSeen(chatKey);
			}
			if (event.type === "chat.tasks") {
				setTasks(
					event.payload.tasks.map((task) => ({
						index: task.index,
						title: task.title,
						status: task.status,
						details: "",
						createdAt: Date.now(),
						updatedAt: Date.now(),
					})),
				);
			}
		});
	}, [applyServerMessages, chatKey, client, markChatSeen]);

	// Rebind when the live card mounts (`busy` toggles `liveRef`).
	// biome-ignore lint/correctness/useExhaustiveDependencies: busy is the mount signal for liveRef
	useEffect(() => {
		const node = liveRef.current;
		if (!node || typeof IntersectionObserver === "undefined") return;
		const observer = new IntersectionObserver(
			(entries) => {
				const entry = entries[0];
				setLiveInView(Boolean(entry?.isIntersecting));
			},
			{ root: scrollRef.current, threshold: 0.2 },
		);
		observer.observe(node);
		return () => observer.disconnect();
	}, [busy, scrollRef]);

	useEffect(() => {
		if (view !== "raw") return;
		void loadAttempt;
		let cancelled = false;
		setRawPhase("loading");
		setRawError(null);
		setEntries([]);
		void client
			.callRpc<{ entries: RawTranscriptEntry[] }>("chat.entries", { chatKey })
			.then((res) => {
				if (cancelled) return;
				if (!res.ok) {
					setRawPhase("error");
					setRawError(res.error?.message ?? "Could not load transcript");
					return;
				}
				setEntries(res.result?.entries ?? []);
				setRawPhase("ready");
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setRawPhase("error");
				setRawError(
					err instanceof Error ? err.message : "Could not load transcript",
				);
			});
		return () => {
			cancelled = true;
		};
	}, [view, chatKey, client, loadAttempt]);

	const wasDown = useRef(false);
	useEffect(() => {
		if (connectionStatus !== "connected") {
			wasDown.current = true;
			return;
		}
		if (!wasDown.current) return;
		wasDown.current = false;
		let cancelled = false;
		void (async () => {
			const [, history, listed] = await Promise.all([
				refreshChatStatus(chatKey),
				client.callRpc<{ messages?: TranscriptMessageView[] }>(
					"chat.messages",
					{ chatKey },
				),
				client.callRpc<{ tasks?: ChatTask[] }>("chat.tasks.list", { chatKey }),
			]);
			if (cancelled) return;
			if (history.ok && history.result?.messages) {
				applyServerMessages(history.result.messages);
			}
			if (listed.ok && listed.result?.tasks) setTasks(listed.result.tasks);
			await client.callRpc("chat.subscribe", { chatKey });
		})();
		return () => {
			cancelled = true;
		};
	}, [
		applyServerMessages,
		chatKey,
		client,
		connectionStatus,
		refreshChatStatus,
	]);

	const items = useMemo(() => groupToolRuns(messages), [messages]);
	const newDividerIndex = useMemo(() => {
		if (newFromId == null) return -1;
		return items.findIndex((item) => {
			if (item.type === "assistant") return item.message.id === newFromId;
			if (item.type === "tools") {
				return item.startId <= newFromId && item.endId >= newFromId;
			}
			return false;
		});
	}, [items, newFromId]);
	const progress = taskProgress(tasks);
	const source = record ?? chat;
	const archived = Boolean(source?.closed);
	const firstUserText = messages.find(
		(message) => message.role === "user" && message.text.trim(),
	)?.text;
	const title = chatTitle(
		source ?? { key: chatKey },
		live?.lastUserText ?? firstUserText,
	);
	const untitled = !source?.title?.trim();
	const harvestOn = source?.harvest !== false;

	function setView(next: "chat" | "raw") {
		void navigate({
			to: "/chat/$chatKey",
			params: { chatKey },
			search: { view: next },
		});
	}

	async function saveTitle(next: string) {
		setRenaming(false);
		const renamed = await client.callRpc<{ chat: ChatRecord }>("chat.rename", {
			chatKey,
			title: next,
		});
		if (renamed.ok && renamed.result?.chat) setRecord(renamed.result.chat);
		await refreshDirectory();
	}

	async function send(text: string, steer: boolean) {
		noteUserText(chatKey, text);
		if (connectionStatus !== "connected") {
			const clientMsgId = crypto.randomUUID();
			const optimistic: TranscriptMessageView = {
				id: Date.now(),
				role: "user",
				text,
				timestamp: Date.now(),
			};
			pendingOptimistic.current = [...pendingOptimistic.current, optimistic];
			setMessages((prev) => [...prev, optimistic]);
			queueTurn({ chatKey, text, clientMsgId, whenBusy: "queue" });
			return;
		}
		if (busy && steer) {
			await client.callRpc("turn.steer", { chatKey, text });
			setSteerOn(false);
			return;
		}
		if (busy) {
			setQueued((prev) => [...prev, text]);
			await client.callRpc("turn.submit", {
				chatKey,
				text,
				whenBusy: "queue",
			});
			return;
		}
		setMessages((prev) => [
			...prev,
			{
				id: Date.now(),
				role: "user",
				text,
				timestamp: Date.now(),
			},
		]);
		ignoreStaleBusy.current = false;
		setLocalBusy(true);
		await client.callRpc("turn.submit", { chatKey, text, whenBusy: "queue" });
		void refreshDirectory();
	}

	const stepTitle = progress.determinate
		? progress.currentTitle
			? `Working · step ${progress.currentIndex} of ${progress.total}`
			: `Working · ${progress.done}/${progress.total}`
		: live?.lastToolName
			? `Working · ${live.lastToolName}`
			: "Working";

	const collapsedTitle = progress.determinate
		? `${progress.currentIndex ?? progress.done}/${progress.total} ${progress.currentTitle ?? ""}`.trim()
		: stepTitle;

	return (
		<AppShell
			title={title}
			titleMuted={title === "New task"}
			titleNode={
				renaming ? (
					<InlineEditTitle
						value={untitled ? "" : title}
						onCancel={() => setRenaming(false)}
						onSave={(next) => {
							void saveTitle(next);
						}}
					/>
				) : undefined
			}
			backTo="/"
			subtitle={
				<div className="flex items-center gap-2 text-[length:var(--fs-sm)] text-text-muted">
					{bot ? <BotPill bot={bot} /> : null}
					{archived ? <span>Archived</span> : null}
					{archived ? null : (
						<ChatStatusIndicator
							status={live?.status}
							busy={busy}
							model={bot?.model}
						/>
					)}
					{!archived && live?.failedReason ? (
						<StatusShape status="failed" />
					) : null}
				</div>
			}
			actions={
				renaming ? undefined : (
					<button
						type="button"
						aria-label="Chat menu"
						onClick={() => setMenuOpen(true)}
						className="inline-flex min-h-tap min-w-tap items-center justify-center text-text-muted"
					>
						⋯
					</button>
				)
			}
		>
			<ChatMenuSheet
				open={menuOpen}
				onOpenChange={setMenuOpen}
				title={title}
				bot={bot}
				archived={archived}
				harvestOn={harvestOn}
				onHarvestChange={(on) => {
					setRecord((prev) => (prev ? { ...prev, harvest: on } : prev));
					void client.callRpc("chat.update", { chatKey, harvest: on });
				}}
				onRename={() => {
					setMenuOpen(false);
					setRenaming(true);
				}}
				onRaw={() => {
					setMenuOpen(false);
					setView("raw");
				}}
				onArchive={() => {
					setMenuOpen(false);
					void archiveChat(chatKey).then(() => {
						void navigate({ to: "/" });
					});
				}}
				onOpenProfile={() => {
					if (!source?.botId) return;
					setMenuOpen(false);
					void navigate({
						to: "/bot/$botId/$tab",
						params: { botId: source.botId, tab: "schedules" },
					});
				}}
			/>
			<div className="flex min-h-0 flex-1 flex-col">
				{view === "raw" ? (
					<div className="flex justify-center px-3 pt-2">
						<SegmentedControl
							ariaLabel="Transcript view"
							className="w-fit"
							value={view}
							onValueChange={(next) => {
								if (next === "chat" || next === "raw") setView(next);
							}}
							options={[
								{ value: "chat", label: "Chat" },
								{ value: "raw", label: "Raw" },
							]}
						/>
					</div>
				) : null}
				{archived ? (
					<p className="border-b border-border py-2 text-center text-[length:var(--fs-sm)] text-text-muted">
						Archived · read-only
					</p>
				) : null}
				<div
					id="chat-scroller"
					ref={scrollRef}
					onScroll={(event) => {
						handleScroll(event);
						const el = event.currentTarget;
						setLiveInView(
							isNearBottom(el.scrollHeight, el.scrollTop, el.clientHeight),
						);
					}}
					className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
					style={busy ? { minHeight: 0 } : undefined}
				>
					{view === "raw" ? (
						rawPhase === "loading" ? (
							<SkeletonBlock label="Loading transcript" />
						) : rawPhase === "error" ? (
							<LoadError
								message={rawError ?? "Could not load transcript"}
								onRetry={() => setLoadAttempt((value) => value + 1)}
							/>
						) : (
							<RawTranscript entries={entries} />
						)
					) : transcriptPhase === "loading" ? (
						<SkeletonBlock label="Loading chat" />
					) : transcriptPhase === "error" ? (
						<LoadError
							message={transcriptError ?? "Could not load chat"}
							onRetry={() => setLoadAttempt((value) => value + 1)}
						/>
					) : messages.length === 0 && queued.length === 0 ? (
						<p className="py-16 text-center text-[length:var(--fs-sm)] text-text-muted">
							Describe the task in as much detail as you like.
							<br />
							The bot takes it from there.
						</p>
					) : null}
					{view === "raw"
						? null
						: items.map((item, index) => {
								const showDivider = index === newDividerIndex;
								if (item.type === "user") {
									return (
										<div key={`u-${item.message.id}`}>
											{showDivider ? <NewDivider count={newCount} /> : null}
											<div className="mb-3 flex justify-end">
												<div className="max-w-[85%] rounded-lg bg-accent px-3 py-2 text-on-accent">
													<Markdown
														source={item.message.text}
														variant="onAccent"
													/>
												</div>
											</div>
										</div>
									);
								}
								if (item.type === "assistant") {
									return (
										<div key={`a-${item.message.id}`}>
											{showDivider ? <NewDivider count={newCount} /> : null}
											<div className="mb-3 flex gap-2">
												{bot ? (
													<BotBadge
														bot={bot}
														className="mt-1 size-7 min-h-0 min-w-0 text-[length:var(--fs-xs)]"
													/>
												) : null}
												<div className="min-w-0 flex-1">
													<Markdown source={item.message.text} />
												</div>
											</div>
										</div>
									);
								}
								if (item.type === "tools") {
									return (
										<div key={`t-${item.startId}`}>
											{showDivider ? <NewDivider count={newCount} /> : null}
											<ToolRunRow names={item.names} count={item.count} />
										</div>
									);
								}
								return null;
							})}

					{busy && !archived && view === "chat" ? (
						<div ref={liveRef} className="mb-3">
							<LiveCard
								title={collapsed ? collapsedTitle : stepTitle}
								collapsed={collapsed}
								frozen={connectionStatus !== "connected"}
								onToggle={() => setCollapsed((value) => !value)}
								progress={progress.determinate ? progress.ratio : undefined}
								onSteer={() => {
									setSteerOn(true);
									document
										.querySelector<HTMLTextAreaElement>(
											'[aria-label="Message"]',
										)
										?.focus();
								}}
								onStop={() => {
									localBusyEpoch.current += 1;
									ignoreStaleBusy.current = true;
									markFailed(chatKey, "aborted");
									setLocalBusy(false);
									void client.callRpc("turn.interrupt", { chatKey });
								}}
							>
								{progress.currentTitle ? (
									<p className="mb-1 text-text">{progress.currentTitle}</p>
								) : null}
								<pre className="max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[length:var(--fs-xs)]">
									{live?.streamText?.slice(-800) ||
										live?.lastToolName ||
										"Waiting for a turn."}
								</pre>
							</LiveCard>
						</div>
					) : null}
					{view === "chat"
						? queued.map((text) => (
								<div key={text} className="mb-4 flex flex-col items-end">
									<div className="max-w-[85%] rounded-lg border border-dashed border-border bg-surface px-3 py-2 text-text-muted">
										{text}
									</div>
									<p className="mt-1 text-[length:var(--fs-xs)] text-text-muted">
										Queued, runs after this step
									</p>
								</div>
							))
						: null}
				</div>
				{busy && !liveInView && !archived && view === "chat" ? (
					<button
						type="button"
						aria-label="Jump to live"
						onClick={() => {
							scrollToBottom();
							liveRef.current?.scrollIntoView({ block: "end" });
						}}
						className="mx-auto -mt-2 mb-1 flex min-h-tap items-center gap-2 rounded-full border border-border bg-surface-raised px-3 text-[length:var(--fs-sm)] shadow-[var(--shadow)]"
					>
						<StatusShape status="running" />
						Jump to live ↓
					</button>
				) : null}
				{archived ? null : (
					<Composer
						placeholder="Add a follow-up..."
						steerEnabled={busy}
						steerOn={steerOn}
						onSteerChange={setSteerOn}
						onSend={(text, steer) => {
							void send(text, steer);
						}}
					/>
				)}
			</div>
		</AppShell>
	);
}

function NewDivider({ count }: { count: number }) {
	return (
		<p className="my-4 flex items-center gap-2 text-center text-[length:var(--fs-sm)] text-accent">
			<span className="h-px flex-1 bg-accent/40" />
			{count} new
			<span className="h-px flex-1 bg-accent/40" />
		</p>
	);
}

function ToolRunRow({ names, count }: { names: string[]; count: number }) {
	const [open, setOpen] = useState(false);
	const preview = names.slice(0, 2).join(", ");
	return (
		<div className="mb-3">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}
				className="flex min-h-tap w-full items-center gap-2 rounded-md border border-border px-3 text-left text-[length:var(--fs-sm)] text-text-muted"
			>
				<span aria-hidden="true">✓</span>
				<span className="min-w-0 flex-1 truncate">
					Ran {count} tool{count === 1 ? "" : "s"}
					{preview ? ` · ${preview}` : ""}
				</span>
				<span>{open ? "▾" : "›"}</span>
			</button>
			{open ? (
				<ul className="mt-1 px-3 font-mono text-[length:var(--fs-xs)] text-text-muted">
					{names.map((name) => (
						<li key={name}>{name}</li>
					))}
				</ul>
			) : null}
		</div>
	);
}
