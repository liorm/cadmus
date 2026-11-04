import type {
	ChatRecord,
	ChatTask,
	TranscriptMessageView,
} from "@cadmus/contract/types";
import { useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { BotBadge } from "@/components/BotBadge";
import { BotPill } from "@/components/BotChip";
import { Composer } from "@/components/Composer";
import { LiveCard } from "@/components/LiveCard";
import { Markdown } from "@/components/Markdown";
import { StatusShape } from "@/components/StatusShape";
import { useCadmus } from "@/context/CadmusContext";
import { isNearBottom, useAutoScroll } from "@/hooks/useAutoScroll";
import { chatTitle } from "@/lib/format-time";
import { groupToolRuns } from "@/lib/group-tool-runs";
import { taskProgress } from "@/lib/task-progress";

export function ChatPage() {
	const { chatKey } = useParams({ from: "/chat/$chatKey" });
	const {
		client,
		bots,
		chats,
		chatStates,
		markChatSeen,
		noteUserText,
		markFailed,
		refreshDirectory,
	} = useCadmus();
	const chat = chats.find((entry) => entry.key === chatKey);
	const bot = bots.find((entry) => entry.id === chat?.botId);
	const live = chatStates[chatKey];
	const [localBusy, setLocalBusy] = useState(false);
	const busy = localBusy || Boolean(live?.busy);
	const [messages, setMessages] = useState<TranscriptMessageView[]>([]);
	const [tasks, setTasks] = useState<ChatTask[]>([]);
	const [queued, setQueued] = useState<string[]>([]);
	const [steerOn, setSteerOn] = useState(false);
	const [collapsed, setCollapsed] = useState(false);
	const [liveInView, setLiveInView] = useState(true);
	const [newFromId, setNewFromId] = useState<number | null>(null);
	const [newCount, setNewCount] = useState(0);
	const liveRef = useRef<HTMLDivElement | null>(null);

	const { scrollRef, handleScroll, scrollToBottom } = useAutoScroll({
		chatKey,
		streamingActive: busy,
		hasNewUserMessage: queued.length > 0,
	});

	useEffect(() => {
		const previous = markChatSeen(chatKey);
		let cancelled = false;
		void (async () => {
			const res = await client.callRpc<{
				chat: ChatRecord;
				messages: TranscriptMessageView[];
				busy: boolean;
				tasks?: ChatTask[];
			}>("chat.get", { chatKey });
			if (cancelled || !res.ok || !res.result) return;
			setMessages(res.result.messages);
			setLocalBusy(Boolean(res.result.busy));
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
		})();
		return () => {
			cancelled = true;
		};
	}, [chatKey, client, markChatSeen]);

	useEffect(() => {
		return client.subscribe((event) => {
			if ("payload" in event && event.payload && "chatKey" in event.payload) {
				const key = (event.payload as { chatKey?: string }).chatKey;
				if (key !== chatKey) return;
			} else {
				return;
			}
			if (event.type === "chat.state") {
				setLocalBusy(event.payload.busy);
			}
			if (event.type === "turn.completed") {
				setLocalBusy(false);
				void client
					.callRpc<{ messages: TranscriptMessageView[] }>("chat.get", {
						chatKey,
					})
					.then((res) => {
						if (res.ok && res.result?.messages)
							setMessages(res.result.messages);
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
	}, [chatKey, client, markChatSeen]);

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
	const title = chatTitle(chat ?? { key: chatKey }, live?.lastUserText);
	const untitled = !chat?.title?.trim();

	async function send(text: string, steer: boolean) {
		noteUserText(chatKey, text);
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
			title={untitled ? "New task" : title}
			titleMuted={untitled}
			backTo="/"
			subtitle={
				<div className="flex items-center gap-2 text-[length:var(--fs-sm)] text-text-muted">
					{bot ? <BotPill bot={bot} /> : null}
					{busy ? (
						<>
							<StatusShape status="running" />
							<span>Running</span>
						</>
					) : live?.failedReason ? (
						<StatusShape status="failed" />
					) : null}
				</div>
			}
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
					{messages.length === 0 && queued.length === 0 ? (
						<p className="py-16 text-center text-[length:var(--fs-sm)] text-text-muted">
							Describe the task in as much detail as you like.
							<br />
							The bot takes it from there.
						</p>
					) : null}
					{items.map((item, index) => {
						const showDivider = index === newDividerIndex;
						if (item.type === "user") {
							return (
								<div key={`u-${item.message.id}`}>
									{showDivider ? <NewDivider count={newCount} /> : null}
									<div className="mb-3 flex justify-end">
										<div className="max-w-[85%] rounded-lg bg-accent px-3 py-2 text-on-accent">
											{item.message.text}
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

					{busy ? (
						<div ref={liveRef} className="mb-3">
							<LiveCard
								title={collapsed ? collapsedTitle : stepTitle}
								collapsed={collapsed}
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
					{queued.map((text) => (
						<div key={text} className="mb-4 flex flex-col items-end">
							<div className="max-w-[85%] rounded-lg border border-dashed border-border bg-surface px-3 py-2 text-text-muted">
								{text}
							</div>
							<p className="mt-1 text-[length:var(--fs-xs)] text-text-muted">
								Queued, runs after this step
							</p>
						</div>
					))}
				</div>
				{busy && !liveInView ? (
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
				<Composer
					placeholder="Add a follow-up..."
					steerEnabled={busy}
					steerOn={steerOn}
					onSteerChange={setSteerOn}
					onSend={(text, steer) => {
						void send(text, steer);
					}}
				/>
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
