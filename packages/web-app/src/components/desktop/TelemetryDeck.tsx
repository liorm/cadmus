import type { ChatTask, TranscriptMessageView } from "@cadmus/contract/types";
import { Link } from "@tanstack/react-router";
import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HarvestView } from "@/components/HarvestView";
import { useCadmus } from "@/context/CadmusContext";
import { groupToolRuns, type ToolExecutionDetail } from "@/lib/group-tool-runs";
import { taskProgress } from "@/lib/task-progress";

type DeckTab = "tools" | "tasks" | "harvest";

const TABS: ReadonlyArray<{ id: DeckTab; label: string }> = [
	{ id: "tools", label: "Tool stream" },
	{ id: "tasks", label: "Task plan" },
	{ id: "harvest", label: "Memory harvest" },
];

function formatJson(value: unknown): string {
	if (value === undefined) return "";
	let text: string;
	try {
		text = JSON.stringify(value);
	} catch {
		text = String(value);
	}
	if (text.length <= 800) return text;
	return `${text.slice(0, 800)}…`;
}

function truncate(text: string): string {
	if (text.length <= 800) return text;
	return `${text.slice(0, 800)}…`;
}

function eventChatKey(event: { payload?: unknown }): string | undefined {
	const payload = event.payload;
	if (!payload || typeof payload !== "object" || !("chatKey" in payload)) {
		return undefined;
	}
	const key = payload.chatKey;
	return typeof key === "string" ? key : undefined;
}

export function TelemetryDeck({
	chatKey,
	botId,
	isStageChat = false,
}: {
	chatKey: string | null;
	botId: string;
	isStageChat?: boolean;
}): JSX.Element {
	const {
		bots,
		chatStates,
		client,
		connectionStatus,
		subscribeEvents,
		activeChat,
	} = useCadmus();
	const [tab, setTab] = useState<DeckTab>("tools");
	const [localMessages, setLocalMessages] = useState<TranscriptMessageView[]>(
		[],
	);
	const [localTasks, setLocalTasks] = useState<ChatTask[]>([]);
	const isShared = isStageChat || activeChat.chatKey === chatKey;
	const messages = isShared ? activeChat.messages : localMessages;
	const tasks = isShared ? activeChat.tasks : localTasks;
	const messageReq = useRef(0);
	const taskReq = useRef(0);
	const scroller = useRef<HTMLDivElement | null>(null);

	const loadMessages = useCallback(
		async (key: string) => {
			const id = ++messageReq.current;
			const history = await client.callRpc<{
				messages?: TranscriptMessageView[];
			}>("chat.messages", { chatKey: key });
			if (id !== messageReq.current) return;
			if (history.ok) setLocalMessages(history.result?.messages ?? []);
		},
		[client],
	);

	const loadTasks = useCallback(
		async (key: string) => {
			const id = ++taskReq.current;
			const listed = await client.callRpc<{ tasks: ChatTask[] }>(
				"chat.tasks.list",
				{ chatKey: key },
			);
			if (id !== taskReq.current) return;
			if (listed.ok) setLocalTasks(listed.result?.tasks ?? []);
		},
		[client],
	);

	useEffect(() => {
		if (!chatKey || isStageChat || activeChat.chatKey === chatKey) {
			messageReq.current += 1;
			taskReq.current += 1;
			setLocalMessages([]);
			setLocalTasks([]);
			return;
		}
		setLocalMessages([]);
		setLocalTasks([]);
		void loadMessages(chatKey);
		void loadTasks(chatKey);
	}, [chatKey, isStageChat, activeChat.chatKey, loadMessages, loadTasks]);

	useEffect(() => {
		if (!chatKey || isStageChat || activeChat.chatKey === chatKey) return;
		return subscribeEvents((event) => {
			if (eventChatKey(event) !== chatKey) return;
			if (
				event.type === "turn.completed" ||
				event.type === "turn.tool_result"
			) {
				void loadMessages(chatKey);
			}
			if (event.type === "chat.tasks") {
				const incoming = event.payload.tasks;
				taskReq.current += 1;
				setLocalTasks((prev) =>
					incoming.map((task) => {
						const existing = prev.find((item) => item.index === task.index);
						return {
							index: task.index,
							title: task.title,
							status: task.status,
							details: existing?.details ?? "",
							...(existing?.summary !== undefined
								? { summary: existing.summary }
								: {}),
							createdAt: existing?.createdAt ?? Date.now(),
							updatedAt: Date.now(),
						};
					}),
				);
			}
		});
	}, [chatKey, isStageChat, activeChat.chatKey, loadMessages, subscribeEvents]);

	const wasDown = useRef(false);
	const hasConnected = useRef(false);
	useEffect(() => {
		if (!chatKey || isStageChat || activeChat.chatKey === chatKey) return;
		if (connectionStatus !== "connected") {
			if (hasConnected.current) wasDown.current = true;
			return;
		}
		if (!hasConnected.current) {
			hasConnected.current = true;
			return;
		}
		if (!wasDown.current) return;
		wasDown.current = false;
		void loadMessages(chatKey);
		void loadTasks(chatKey);
	}, [
		chatKey,
		isStageChat,
		activeChat.chatKey,
		connectionStatus,
		loadMessages,
		loadTasks,
	]);

	const calls = useMemo(() => {
		const next: Array<{ key: string; call: ToolExecutionDetail }> = [];
		let seq = 0;
		for (const item of groupToolRuns(messages)) {
			if (item.type !== "tools") continue;
			for (const call of item.calls) {
				seq += 1;
				next.push({ key: `${call.id}:${seq}`, call });
			}
		}
		return next;
	}, [messages]);

	useEffect(() => {
		const node = scroller.current;
		const latest = calls[calls.length - 1];
		if (!node || !latest) return;
		node.scrollTop = node.scrollHeight;
	}, [calls]);

	const bot = bots.find((entry) => entry.id === botId);
	const active = chatKey ? chatStates[chatKey]?.activeTool : undefined;
	const progress = taskProgress(tasks);

	return (
		<aside
			aria-label="Telemetry"
			className="flex h-full min-h-0 flex-col bg-surface font-mono text-[length:var(--fs-xs)]"
		>
			<div
				role="tablist"
				aria-label="Telemetry"
				className="flex shrink-0 gap-1 border-b border-border p-1"
			>
				{TABS.map((item) => (
					<button
						key={item.id}
						type="button"
						role="tab"
						aria-selected={tab === item.id}
						className={`min-h-tap flex-1 rounded-md px-2 ${tab === item.id ? "bg-bg text-text" : "text-text-muted"}`}
						onClick={() => setTab(item.id)}
					>
						{item.label}
					</button>
				))}
			</div>
			<div className="flex min-h-0 flex-1 flex-col">
				{tab === "tools" ? (
					<div className="flex min-h-0 flex-1 flex-col">
						{active ? (
							<div className="shrink-0 border-b border-border px-2 py-1">
								<div>Active: {active.toolName}</div>
								{active.args ? (
									<pre className="overflow-x-auto whitespace-pre-wrap break-all text-text-muted">
										{formatJson(active.args)}
									</pre>
								) : null}
							</div>
						) : null}
						<div
							ref={scroller}
							className="min-h-0 flex-1 overflow-y-auto px-2 py-1"
						>
							{calls.length === 0 ? (
								<p className="text-text-muted">No tool calls yet.</p>
							) : (
								<ul className="flex flex-col gap-2">
									{calls.map(({ key, call }) => {
										const failed = Boolean(
											call.isError || call.result?.isError,
										);
										const body = call.result?.content;
										return (
											<li key={key} className="border-b border-border pb-2">
												<div>{call.name}</div>
												{call.args !== undefined ? (
													<pre className="overflow-x-auto whitespace-pre-wrap break-all text-text-muted">
														{formatJson(call.args)}
													</pre>
												) : null}
												{failed ? (
													<pre className="overflow-x-auto whitespace-pre-wrap break-all text-status-failed">
														{body ? truncate(body) : "error"}
													</pre>
												) : body ? (
													<pre className="overflow-x-auto whitespace-pre-wrap break-all">
														{truncate(body)}
													</pre>
												) : null}
											</li>
										);
									})}
								</ul>
							)}
						</div>
						{bot ? (
							<div className="shrink-0 border-t border-border px-2 py-1">
								{bot.tools === undefined ? (
									<p className="text-text-muted">Default tool set</p>
								) : (
									<ul className="flex flex-wrap gap-1">
										{bot.tools.map((name) => (
											<li
												key={name}
												className="rounded-md border border-border px-1"
											>
												{name}
											</li>
										))}
									</ul>
								)}
							</div>
						) : null}
					</div>
				) : null}
				{tab === "tasks" ? (
					<div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
						{!chatKey ? (
							<p className="text-text-muted">Select a thread to see tasks.</p>
						) : tasks.length === 0 ? (
							<p className="text-text-muted">No task plan for this chat.</p>
						) : (
							<div className="flex flex-col gap-2">
								{progress.determinate ? (
									<p>
										{progress.done}/{progress.total}
									</p>
								) : null}
								<ul className="flex flex-col gap-2">
									{tasks.map((task) => (
										<li
											key={task.index}
											className="border-b border-border pb-2"
										>
											<div className="flex items-baseline justify-between gap-2">
												<span>
													{task.index}. {task.title}
												</span>
												<span className="text-text-muted">{task.status}</span>
											</div>
											{task.details ? <p>{task.details}</p> : null}
											{task.summary ? (
												<p className="text-text-muted">{task.summary}</p>
											) : null}
										</li>
									))}
								</ul>
							</div>
						)}
					</div>
				) : null}
				{tab === "harvest" ? (
					<div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
						{!botId ? (
							<p className="text-text-muted">Select a bot.</p>
						) : (
							<div className="flex flex-col gap-2">
								<div className="flex flex-wrap gap-2">
									<Link
										to="/bot/$botId/doc"
										params={{ botId }}
										search={{ path: "/.cadmus/MEMORY.md" }}
										className="underline"
									>
										Open MEMORY.md
									</Link>
									<Link
										to="/bot/$botId/harvest"
										params={{ botId }}
										className="underline"
									>
										Harvest page
									</Link>
									<Link
										to="/bot/$botId/$tab"
										params={{ botId, tab: "schedules" }}
										className="underline"
									>
										Schedules
									</Link>
								</div>
								<HarvestView botId={botId} />
							</div>
						)}
					</div>
				) : null}
			</div>
			<footer className="shrink-0 border-t border-border px-2 py-1 text-text-muted">
				WS: {connectionStatus}
			</footer>
		</aside>
	);
}
