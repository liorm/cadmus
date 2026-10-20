import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	ChatRecord,
	ChatStatusRecord,
	HarvestNote,
	RawTranscriptEntry,
	ServerEvent,
	ThinkingLevel,
	TranscriptMessageView,
} from "../../../src/protocol.js";
import { useCadmus } from "../context/CadmusContext.js";
import { ChatRawView } from "./ChatRawView.js";
import { ChatRenderedView } from "./ChatRenderedView.js";

const THINKING_LEVELS: ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

interface NewChatModalProps {
	isOpen: boolean;
	onClose: () => void;
	onCreated: (chatKey: string) => void;
}

function NewChatModal({ isOpen, onClose, onCreated }: NewChatModalProps) {
	const { client, bots, selectedBotId } = useCadmus();
	const [botId, setBotId] = useState<string>(
		selectedBotId ?? bots[0]?.id ?? "",
	);
	const [title, setTitle] = useState<string>("");
	const [key, setKey] = useState<string>("");
	const [thinking, setThinking] = useState<ThinkingLevel>("off");
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Update default botId when bots load or selectedBotId changes
	useEffect(() => {
		if (!botId && bots.length > 0) {
			setBotId(selectedBotId ?? bots[0]?.id ?? "");
		}
	}, [bots, selectedBotId, botId]);

	if (!isOpen) return null;

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!botId) {
			setError("Please select a bot for this chat");
			return;
		}

		setIsSubmitting(true);
		setError(null);
		try {
			const res = await client.callRpc("chat.create", {
				botId,
				title: title.trim() || undefined,
				key: key.trim() || undefined,
				thinking,
			});

			if (!res.ok || !res.result?.chat) {
				setError(res.error?.message ?? "Failed to create chat session");
				return;
			}

			onCreated(res.result.chat.key);
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Error creating chat");
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<div className="modal-backdrop">
			<div className="modal-container" style={{ maxWidth: "460px" }}>
				<form onSubmit={handleSubmit}>
					<div className="modal-header">
						<span className="modal-title">+ New Chat Conversation</span>
						<button
							type="button"
							className="btn btn-ghost btn-sm"
							onClick={onClose}
						>
							✕
						</button>
					</div>

					<div className="modal-body">
						{error && (
							<div
								className="alert-banner alert-error"
								style={{ marginBottom: "12px" }}
							>
								{error}
							</div>
						)}

						<div className="form-group">
							<label className="form-label" htmlFor="chat-bot-id">
								Bot Persona
							</label>
							<select
								id="chat-bot-id"
								className="form-input"
								value={botId}
								onChange={(e) => setBotId(e.target.value)}
								disabled={isSubmitting}
							>
								{bots.map((b) => (
									<option key={b.id} value={b.id}>
										{b.name} ({b.id})
									</option>
								))}
							</select>
						</div>

						<div className="form-group">
							<label className="form-label" htmlFor="chat-title">
								Chat Title (optional)
							</label>
							<input
								id="chat-title"
								className="form-input"
								placeholder="e.g. Brainstorming Task 4"
								value={title}
								onChange={(e) => setTitle(e.target.value)}
								disabled={isSubmitting}
							/>
						</div>

						<div className="form-group">
							<label className="form-label" htmlFor="chat-key">
								Custom Chat Key (optional)
							</label>
							<input
								id="chat-key"
								className="form-input"
								placeholder="e.g. dev-session-1"
								value={key}
								onChange={(e) => setKey(e.target.value)}
								disabled={isSubmitting}
							/>
						</div>

						<div className="form-group">
							<label className="form-label" htmlFor="chat-thinking">
								Thinking Level Override
							</label>
							<select
								id="chat-thinking"
								className="form-input"
								value={thinking}
								onChange={(e) => setThinking(e.target.value as ThinkingLevel)}
								disabled={isSubmitting}
							>
								{THINKING_LEVELS.map((tl) => (
									<option key={tl} value={tl}>
										{tl}
									</option>
								))}
							</select>
						</div>
					</div>

					<div className="modal-footer">
						<button
							type="button"
							className="btn btn-secondary"
							onClick={onClose}
							disabled={isSubmitting}
						>
							Cancel
						</button>
						<button
							type="submit"
							className="btn btn-primary"
							disabled={isSubmitting || !botId}
						>
							{isSubmitting ? "Creating..." : "Start Chat"}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}

interface RenameModalProps {
	isOpen: boolean;
	chatKey: string;
	currentTitle?: string;
	onClose: () => void;
	onRenamed: (newTitle: string) => void;
}

function RenameModal({
	isOpen,
	chatKey,
	currentTitle = "",
	onClose,
	onRenamed,
}: RenameModalProps) {
	const { client } = useCadmus();
	const [title, setTitle] = useState<string>(currentTitle);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setTitle(currentTitle);
	}, [currentTitle]);

	if (!isOpen) return null;

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!title.trim()) return;

		setIsSubmitting(true);
		setError(null);
		try {
			const res = await client.callRpc("chat.rename", {
				chatKey,
				title: title.trim(),
			});

			if (!res.ok) {
				setError(res.error?.message ?? "Failed to rename chat");
				return;
			}

			onRenamed(title.trim());
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Error renaming chat");
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<div className="modal-backdrop">
			<div className="modal-container" style={{ maxWidth: "420px" }}>
				<form onSubmit={handleSubmit}>
					<div className="modal-header">
						<span className="modal-title">Rename Chat</span>
						<button
							type="button"
							className="btn btn-ghost btn-sm"
							onClick={onClose}
						>
							✕
						</button>
					</div>

					<div className="modal-body">
						{error && (
							<div
								className="alert-banner alert-error"
								style={{ marginBottom: "12px" }}
							>
								{error}
							</div>
						)}

						<div className="form-group">
							<label className="form-label" htmlFor="rename-chat-title">
								New Title
							</label>
							<input
								id="rename-chat-title"
								className="form-input"
								value={title}
								onChange={(e) => setTitle(e.target.value)}
								disabled={isSubmitting}
							/>
						</div>
					</div>

					<div className="modal-footer">
						<button
							type="button"
							className="btn btn-secondary"
							onClick={onClose}
							disabled={isSubmitting}
						>
							Cancel
						</button>
						<button
							type="submit"
							className="btn btn-primary"
							disabled={isSubmitting || !title.trim()}
						>
							{isSubmitting ? "Saving..." : "Save Title"}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}

// ─── Out-of-band Status Drawer ────────────────────────────────────────────────

function StatusDrawer({
	isOpen,
	record,
	text,
	onClose,
}: {
	isOpen: boolean;
	record?: ChatStatusRecord;
	text?: string;
	onClose: () => void;
}) {
	if (!isOpen) return null;

	return (
		<div className="status-drawer-overlay">
			<div className="status-drawer">
				<div className="status-drawer-header">
					<div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
						<span style={{ fontSize: "16px" }}>⚡</span>
						<strong>Out-of-Band Runtime Status (/status)</strong>
					</div>
					<button
						type="button"
						className="btn btn-ghost btn-sm"
						onClick={onClose}
					>
						✕ Close
					</button>
				</div>

				<div className="status-drawer-body">
					{record && (
						<div className="status-metrics-grid">
							<div className="status-metric-card">
								<span className="metric-label">Bot</span>
								<strong className="metric-val">{record.botName}</strong>
								<span className="badge badge-cyan">{record.botId}</span>
							</div>
							<div className="status-metric-card">
								<span className="metric-label">Model</span>
								<strong className="metric-val">{record.model}</strong>
							</div>
							<div className="status-metric-card">
								<span className="metric-label">Thinking</span>
								<span className="badge badge-indigo">{record.thinking}</span>
							</div>
							<div className="status-metric-card">
								<span className="metric-label">Status</span>
								<span
									className={`badge ${record.busy ? "badge-amber" : "badge-emerald"}`}
								>
									{record.busy ? "Busy" : "Idle"}
								</span>
							</div>
							<div className="status-metric-card">
								<span className="metric-label">Entries</span>
								<strong className="metric-val">{record.entryCount}</strong>
							</div>
							<div className="status-metric-card">
								<span className="metric-label">Harvest Watermark</span>
								<strong className="metric-val">
									#{record.harvestWatermark}
								</strong>
							</div>
							<div className="status-metric-card">
								<span className="metric-label">Next Alarm Wake</span>
								<span className="metric-val" style={{ fontSize: "11px" }}>
									{record.nextWakeAt
										? new Date(record.nextWakeAt).toLocaleTimeString()
										: "None scheduled"}
								</span>
							</div>
						</div>
					)}

					{text && (
						<div className="status-text-section">
							<div className="inner-block-title">Formatted Status Output</div>
							<pre className="code-block status-pre">{text}</pre>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

// ─── Main ChatWorkspace Component ─────────────────────────────────────────────

export interface ChatWorkspaceProps {
	initialChats?: ChatRecord[];
	initialSelectedKey?: string;
	initialChatData?: {
		chat: ChatRecord;
		busy: boolean;
		messages: TranscriptMessageView[];
		entries: RawTranscriptEntry[];
		notes: HarvestNote[];
	};
}

export function ChatWorkspace({
	initialChats,
	initialSelectedKey,
	initialChatData,
}: ChatWorkspaceProps = {}) {
	const { client, bots, subscribeEvents } = useCadmus();

	// Chats list state
	const [chats, setChats] = useState<ChatRecord[]>(initialChats ?? []);
	const [selectedChatKey, setSelectedChatKey] = useState<string | null>(
		initialSelectedKey ?? initialChats?.[0]?.key ?? null,
	);
	const [botFilter, setBotFilter] = useState<string>("all");
	const [isLoadingChats, setIsLoadingChats] = useState(false);

	// Chat active session state
	const [chatData, setChatData] = useState<{
		chat: ChatRecord;
		busy: boolean;
		messages: TranscriptMessageView[];
		entries: RawTranscriptEntry[];
		notes: HarvestNote[];
	} | null>(initialChatData ?? null);
	const [isLoadingChat, setIsLoadingChat] = useState(false);

	// View Mode: "rendered" | "raw"
	const [viewMode, setViewMode] = useState<"rendered" | "raw">("rendered");

	// Out-of-band /status drawer state
	const [statusDrawer, setStatusDrawer] = useState<{
		open: boolean;
		record?: ChatStatusRecord;
		text?: string;
	}>({ open: false });

	// Modals
	const [isNewChatModalOpen, setIsNewChatModalOpen] = useState(false);
	const [isRenameModalOpen, setIsRenameModalOpen] = useState(false);
	const [isResetConfirmOpen, setIsResetConfirmOpen] = useState(false);

	// Prompt input & controls
	const [inputText, setInputText] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [errorBanner, setErrorBanner] = useState<string | null>(null);

	// Streaming & live frames
	const [streamingState, setStreamingState] = useState<{
		active: boolean;
		thinking: string;
		text: string;
		toolCalls: Array<{
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
			result?: { content: string; isError: boolean };
		}>;
	}>({
		active: false,
		thinking: "",
		text: "",
		toolCalls: [],
	});

	const [liveEvents, setLiveEvents] = useState<ServerEvent[]>([]);
	const [botMessages, setBotMessages] = useState<
		Array<{
			fromBotId: string;
			toBotId: string;
			text: string;
			reply?: string;
			when: number;
		}>
	>([]);

	// Reference for chatKey to use inside event subscription
	const selectedChatKeyRef = useRef<string | null>(selectedChatKey);
	selectedChatKeyRef.current = selectedChatKey;

	// Load chats list
	const refreshChats = useCallback(async () => {
		setIsLoadingChats(true);
		try {
			const res = await client.callRpc("chat.list");
			if (res.ok && res.result?.chats) {
				setChats(res.result.chats);
				// If no chat selected, select the first chat
				const firstChat = res.result.chats[0];
				if (!selectedChatKeyRef.current && firstChat) {
					setSelectedChatKey(firstChat.key);
				}
			}
		} finally {
			setIsLoadingChats(false);
		}
	}, [client]);

	// Load full chat state
	const loadChat = useCallback(
		async (chatKey: string) => {
			setIsLoadingChat(true);
			setErrorBanner(null);
			try {
				const res = await client.callRpc("chat.get", { chatKey });
				if (res.ok && res.result) {
					setChatData({
						chat: res.result.chat,
						busy: res.result.busy,
						messages: res.result.messages,
						entries: res.result.entries,
						notes: res.result.notes,
					});
				} else {
					setErrorBanner(res.error?.message ?? "Failed to load chat details");
				}
			} catch (err) {
				setErrorBanner(
					err instanceof Error ? err.message : "Error loading chat",
				);
			} finally {
				setIsLoadingChat(false);
			}
		},
		[client],
	);

	// Initial load of chats
	useEffect(() => {
		refreshChats();
	}, [refreshChats]);

	// Reload chat when selectedChatKey changes
	useEffect(() => {
		if (selectedChatKey) {
			loadChat(selectedChatKey);
			// Reset streaming state on chat switch
			setStreamingState({
				active: false,
				thinking: "",
				text: "",
				toolCalls: [],
			});
			setStatusDrawer({ open: false });
		} else {
			setChatData(null);
		}
	}, [selectedChatKey, loadChat]);

	// Subscribe to live WebSocket events
	useEffect(() => {
		const unsub = subscribeEvents((event: ServerEvent) => {
			// Keep raw events for Raw View inspector (up to 50)
			setLiveEvents((prev) => [event, ...prev.slice(0, 49)]);

			const currentKey = selectedChatKeyRef.current;
			if (!currentKey) return;

			// Handle turn and chat events matching the active chat
			if (event.type === "turn.delta") {
				if (event.payload.chatKey === currentKey) {
					setStreamingState((prev) => {
						if (event.payload.kind === "thinking") {
							return {
								...prev,
								active: true,
								thinking: prev.thinking + event.payload.delta,
							};
						}
						return {
							...prev,
							active: true,
							text: prev.text + event.payload.delta,
						};
					});
				}
			} else if (event.type === "turn.tool_call") {
				if (event.payload.chatKey === currentKey) {
					setStreamingState((prev) => ({
						...prev,
						active: true,
						toolCalls: [
							...prev.toolCalls,
							{
								toolCallId: event.payload.toolCallId,
								toolName: event.payload.toolName,
								args: event.payload.args,
							},
						],
					}));
				}
			} else if (event.type === "turn.tool_result") {
				if (event.payload.chatKey === currentKey) {
					setStreamingState((prev) => ({
						...prev,
						toolCalls: prev.toolCalls.map((tc) =>
							tc.toolCallId === event.payload.toolCallId
								? {
										...tc,
										result: {
											content: event.payload.content,
											isError: event.payload.isError,
										},
									}
								: tc,
						),
					}));
				}
			} else if (event.type === "turn.completed") {
				if (event.payload.chatKey === currentKey) {
					setStreamingState({
						active: false,
						thinking: "",
						text: "",
						toolCalls: [],
					});
					loadChat(currentKey);
				}
			} else if (event.type === "chat.state") {
				if (event.payload.chatKey === currentKey) {
					setChatData((prev) =>
						prev ? { ...prev, busy: event.payload.busy } : null,
					);
				}
			} else if (event.type === "harvest.note") {
				if (event.payload.chatKey === currentKey) {
					loadChat(currentKey);
				}
			} else if (event.type === "bot.message") {
				if (event.payload.chatKey === currentKey) {
					setBotMessages((prev) => [event.payload, ...prev]);
				}
			}
		});

		return () => unsub();
	}, [subscribeEvents, loadChat]);

	// Out-of-band /status command trigger
	const handleTriggerStatus = async () => {
		if (!selectedChatKey) return;
		setErrorBanner(null);
		try {
			const res = await client.callRpc("turn.command", {
				chatKey: selectedChatKey,
				command: "/status",
			});

			if (res.ok && res.result?.status) {
				setStatusDrawer({
					open: true,
					record: res.result.status,
					text: res.result.text,
				});
			} else {
				setErrorBanner(res.error?.message ?? "Failed to query status");
			}
		} catch (err) {
			setErrorBanner(
				err instanceof Error ? err.message : "Error querying /status",
			);
		}
	};

	// Reset conversation history
	const handleResetChat = async () => {
		if (!selectedChatKey) return;
		setIsResetConfirmOpen(false);
		setIsLoadingChat(true);
		try {
			const res = await client.callRpc("chat.reset", {
				chatKey: selectedChatKey,
			});
			if (res.ok) {
				await loadChat(selectedChatKey);
			} else {
				setErrorBanner(res.error?.message ?? "Failed to reset conversation");
			}
		} catch (err) {
			setErrorBanner(
				err instanceof Error ? err.message : "Error resetting chat",
			);
		} finally {
			setIsLoadingChat(false);
		}
	};

	// Close / archive chat
	const handleCloseChat = async () => {
		if (!selectedChatKey) return;
		try {
			const res = await client.callRpc("chat.close", {
				chatKey: selectedChatKey,
			});
			if (res.ok) {
				await refreshChats();
				await loadChat(selectedChatKey);
			} else {
				setErrorBanner(res.error?.message ?? "Failed to close chat");
			}
		} catch (err) {
			setErrorBanner(err instanceof Error ? err.message : "Error closing chat");
		}
	};

	// Submit Prompt or Intercept /status
	const handleSubmitPrompt = async (e?: React.FormEvent) => {
		if (e) e.preventDefault();
		const prompt = inputText.trim();
		if (!prompt || !selectedChatKey) return;

		// Intercept /status out-of-band
		if (prompt === "/status") {
			setInputText("");
			await handleTriggerStatus();
			return;
		}

		setInputText("");
		setIsSubmitting(true);
		setErrorBanner(null);
		setStreamingState({
			active: true,
			thinking: "",
			text: "",
			toolCalls: [],
		});

		try {
			const res = await client.callRpc("turn.submit", {
				chatKey: selectedChatKey,
				text: prompt,
			});

			if (!res.ok) {
				setErrorBanner(res.error?.message ?? "Turn submission failed");
			} else if (
				res.result &&
				"outOfBand" in res.result &&
				res.result.outOfBand
			) {
				// Handled out-of-band
				const statusRes = res.result as {
					status: ChatStatusRecord;
					text: string;
				};
				setStatusDrawer({
					open: true,
					record: statusRes.status,
					text: statusRes.text,
				});
			} else {
				await loadChat(selectedChatKey);
			}
		} catch (err) {
			setErrorBanner(
				err instanceof Error ? err.message : "Error submitting turn",
			);
		} finally {
			setIsSubmitting(false);
			setStreamingState((prev) => ({ ...prev, active: false }));
		}
	};

	// Steer active turn
	const handleSteer = async () => {
		const steerText = inputText.trim();
		if (!steerText || !selectedChatKey) return;

		setInputText("");
		try {
			const res = await client.callRpc("turn.steer", {
				chatKey: selectedChatKey,
				text: steerText,
			});
			if (!res.ok) {
				setErrorBanner(res.error?.message ?? "Failed to steer turn");
			}
		} catch (err) {
			setErrorBanner(
				err instanceof Error ? err.message : "Error steering turn",
			);
		}
	};

	// Interrupt / abort active turn
	const handleInterrupt = async () => {
		if (!selectedChatKey) return;
		try {
			const res = await client.callRpc("turn.interrupt", {
				chatKey: selectedChatKey,
			});
			if (res.ok) {
				setStreamingState({
					active: false,
					thinking: "",
					text: "",
					toolCalls: [],
				});
				await loadChat(selectedChatKey);
			} else {
				setErrorBanner(res.error?.message ?? "Failed to interrupt turn");
			}
		} catch (err) {
			setErrorBanner(
				err instanceof Error ? err.message : "Error interrupting turn",
			);
		}
	};

	// Filtered chats list
	const filteredChats = useMemo(() => {
		if (botFilter === "all") return chats;
		return chats.filter((c) => c.botId === botFilter);
	}, [chats, botFilter]);

	return (
		<div className="chat-view-container">
			{/* Left Sidebar */}
			<div className="chat-sidebar">
				<div className="panel-header" style={{ gap: "8px" }}>
					<span className="panel-title">Chats</span>
					<button
						type="button"
						className="btn btn-primary btn-sm"
						onClick={() => setIsNewChatModalOpen(true)}
						style={{ marginLeft: "auto" }}
					>
						+ New Chat
					</button>
				</div>

				{/* Bot Filter Dropdown */}
				<div className="chat-sidebar-filter">
					<select
						className="form-input"
						value={botFilter}
						onChange={(e) => setBotFilter(e.target.value)}
						style={{ fontSize: "12px", padding: "6px 8px" }}
					>
						<option value="all">All Bots ({bots.length})</option>
						{bots.map((b) => (
							<option key={b.id} value={b.id}>
								{b.name}
							</option>
						))}
					</select>
				</div>

				{/* Chats List */}
				<div className="chat-sidebar-list">
					{isLoadingChats && chats.length === 0 && (
						<div
							style={{
								padding: "16px",
								color: "var(--text-muted)",
								fontSize: "12px",
							}}
						>
							Loading chats...
						</div>
					)}

					{!isLoadingChats && filteredChats.length === 0 && (
						<div
							style={{
								padding: "16px",
								color: "var(--text-muted)",
								fontSize: "12px",
								textAlign: "center",
							}}
						>
							No chats found. Click <strong>+ New Chat</strong> to start a
							conversation.
						</div>
					)}

					{filteredChats.map((c) => (
						<button
							type="button"
							key={c.key}
							className={`chat-item-card ${selectedChatKey === c.key ? "active" : ""}`}
							onClick={() => setSelectedChatKey(c.key)}
							style={{ textAlign: "left", width: "100%", background: "none" }}
						>
							<div className="chat-item-title">
								<strong>{c.title || c.key}</strong>
							</div>
							<div className="chat-item-meta">
								<span className="badge badge-indigo">{c.botId}</span>
								{c.closed && <span className="badge badge-rose">Closed</span>}
								{c.thinking && (
									<span className="badge badge-ghost">{c.thinking}</span>
								)}
							</div>
						</button>
					))}
				</div>
			</div>

			{/* Main Chat Area */}
			<div className="chat-main-area">
				{!selectedChatKey || !chatData ? (
					<div className="empty-state flex-center" style={{ height: "100%" }}>
						<span className="empty-icon">💬</span>
						<h3>Cadmus Chat Workspace</h3>
						<p>Select a chat thread from the left or create a new one.</p>
						<button
							type="button"
							className="btn btn-primary"
							onClick={() => setIsNewChatModalOpen(true)}
						>
							+ New Chat
						</button>
					</div>
				) : (
					<>
						{/* Chat Header Bar */}
						<div className="chat-header-bar">
							<div className="chat-header-left">
								<div className="chat-header-title">
									<h2>{chatData.chat.title || chatData.chat.key}</h2>
									<span className="chat-key-badge">{`#${chatData.chat.key}`}</span>
								</div>
								<div className="chat-header-badges">
									<span className="badge badge-indigo">
										bot: {chatData.chat.botId}
									</span>
									{chatData.chat.thinking && (
										<span className="badge badge-cyan">
											thinking: {chatData.chat.thinking}
										</span>
									)}
									<span
										className={`badge ${chatData.busy ? "badge-amber" : "badge-emerald"}`}
									>
										{chatData.busy ? "Busy..." : "Idle"}
									</span>
								</div>
							</div>

							<div className="chat-header-right">
								{/* Segmented View Mode Toggle: Rendered | Raw (Blocks) */}
								<div className="segmented-control">
									<button
										type="button"
										className={`segmented-item ${viewMode === "rendered" ? "active" : ""}`}
										onClick={() => setViewMode("rendered")}
									>
										Rendered
									</button>
									<button
										type="button"
										className={`segmented-item ${viewMode === "raw" ? "active" : ""}`}
										onClick={() => setViewMode("raw")}
									>
										Raw (Blocks)
									</button>
								</div>

								{/* Action Buttons */}
								<button
									type="button"
									className="btn btn-secondary btn-sm"
									onClick={handleTriggerStatus}
									title="Query out-of-band status"
								>
									⚡ /status
								</button>

								<button
									type="button"
									className="btn btn-secondary btn-sm"
									onClick={() => setIsRenameModalOpen(true)}
								>
									Rename
								</button>

								<button
									type="button"
									className="btn btn-ghost btn-sm"
									onClick={() => setIsResetConfirmOpen(true)}
								>
									Reset
								</button>

								<button
									type="button"
									className="btn btn-danger btn-sm"
									onClick={handleCloseChat}
								>
									{chatData.chat.closed ? "Closed" : "Close"}
								</button>
							</div>
						</div>

						{/* Error Banner */}
						{errorBanner && (
							<div
								className="alert-banner alert-error"
								style={{ margin: "8px 16px 0 16px" }}
							>
								{errorBanner}
							</div>
						)}

						{/* Chat Body */}
						<div className="chat-body-viewport">
							{/* Out-of-band /status Drawer */}
							<StatusDrawer
								isOpen={statusDrawer.open}
								record={statusDrawer.record}
								text={statusDrawer.text}
								onClose={() => setStatusDrawer({ open: false })}
							/>

							{isLoadingChat && (
								<div className="chat-loading-overlay">
									<div className="badge badge-cyan">
										Loading conversation...
									</div>
								</div>
							)}

							{/* Conditionally Rendered View */}
							{viewMode === "rendered" ? (
								<ChatRenderedView
									messages={chatData.messages}
									notes={chatData.notes}
									streamingState={streamingState}
									botMessages={botMessages}
								/>
							) : (
								<ChatRawView
									entries={chatData.entries}
									messages={chatData.messages}
									liveEvents={liveEvents}
								/>
							)}
						</div>

						{/* Prompt Input & Controls Footer */}
						<div className="chat-input-container">
							<form onSubmit={handleSubmitPrompt} className="chat-input-form">
								<textarea
									className="chat-textarea"
									rows={2}
									placeholder={
										chatData.busy
											? "Turn in progress... Type guidance to Steer or type /status"
											: "Type a prompt (Enter to send, Shift+Enter for newline, or /status for status)..."
									}
									value={inputText}
									onChange={(e) => setInputText(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter" && !e.shiftKey) {
											e.preventDefault();
											if (chatData.busy) {
												handleSteer();
											} else {
												handleSubmitPrompt();
											}
										}
									}}
								/>

								<div className="chat-input-actions">
									{chatData.busy || isSubmitting ? (
										<>
											<button
												type="button"
												className="btn btn-primary btn-sm"
												onClick={handleSteer}
												disabled={!inputText.trim()}
												title="Steer active model turn with prompt"
											>
												Steer
											</button>
											<button
												type="button"
												className="btn btn-danger btn-sm"
												onClick={handleInterrupt}
												title="Interrupt active turn"
											>
												Interrupt / Abort
											</button>
										</>
									) : (
										<button
											type="submit"
											className="btn btn-primary btn-sm"
											disabled={!inputText.trim() || isSubmitting}
										>
											{isSubmitting ? "Sending..." : "Send Prompt"}
										</button>
									)}
								</div>
							</form>
						</div>
					</>
				)}
			</div>

			{/* New Chat Modal */}
			<NewChatModal
				isOpen={isNewChatModalOpen}
				onClose={() => setIsNewChatModalOpen(false)}
				onCreated={(newKey) => {
					refreshChats();
					setSelectedChatKey(newKey);
				}}
			/>

			{/* Rename Modal */}
			{chatData && (
				<RenameModal
					isOpen={isRenameModalOpen}
					chatKey={chatData.chat.key}
					currentTitle={chatData.chat.title}
					onClose={() => setIsRenameModalOpen(false)}
					onRenamed={(newTitle) => {
						setChatData((prev) =>
							prev
								? {
										...prev,
										chat: { ...prev.chat, title: newTitle },
									}
								: null,
						);
						refreshChats();
					}}
				/>
			)}

			{/* Reset Confirmation Modal */}
			{isResetConfirmOpen && (
				<div className="modal-backdrop">
					<div className="modal-container" style={{ maxWidth: "400px" }}>
						<div className="modal-header">
							<span className="modal-title">Reset Conversation History?</span>
							<button
								type="button"
								className="btn btn-ghost btn-sm"
								onClick={() => setIsResetConfirmOpen(false)}
							>
								✕
							</button>
						</div>
						<div className="modal-body">
							<p style={{ color: "var(--text-secondary)", fontSize: "13px" }}>
								Are you sure you want to reset this chat's conversation history?
								The chat routing key will be preserved, but all transcript
								entries will be reset.
							</p>
						</div>
						<div className="modal-footer">
							<button
								type="button"
								className="btn btn-secondary"
								onClick={() => setIsResetConfirmOpen(false)}
							>
								Cancel
							</button>
							<button
								type="button"
								className="btn btn-danger"
								onClick={handleResetChat}
							>
								Reset History
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
