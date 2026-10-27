import type {
	ChatRecord,
	HarvestNote,
	ServerEvent,
} from "@cadmus/contract/types";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useCadmus } from "../context/CadmusContext.js";

interface UnifiedDiffViewerProps {
	diff: string;
}

export function UnifiedDiffViewer({ diff }: UnifiedDiffViewerProps) {
	const lines = useMemo(() => {
		if (!diff) return [];
		return diff.split("\n");
	}, [diff]);

	if (lines.length === 0) {
		return (
			<div className="diff-container" style={{ padding: "8px 12px" }}>
				<span style={{ color: "var(--text-muted)", fontSize: "11px" }}>
					(Empty diff)
				</span>
			</div>
		);
	}

	return (
		<div className="diff-container">
			{lines.map((line, idx) => {
				let lineClass = "diff-line";
				let prefixChar = " ";

				if (line.startsWith("+") && !line.startsWith("+++")) {
					lineClass = "diff-line diff-line-add";
					prefixChar = "+";
				} else if (line.startsWith("-") && !line.startsWith("---")) {
					lineClass = "diff-line diff-line-del";
					prefixChar = "-";
				} else if (line.startsWith("@@")) {
					lineClass = "diff-line diff-line-hunk";
					prefixChar = "@";
				}

				return (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: lines in diff lack unique natural IDs
						key={idx}
						className={lineClass}
					>
						<span className="diff-gutter">{idx + 1}</span>
						<span className="diff-prefix">{prefixChar}</span>
						<span className="diff-content">{line}</span>
					</div>
				);
			})}
		</div>
	);
}

export interface HarvestInspectorProps {
	initialNotes?: HarvestNote[];
	initialChats?: ChatRecord[];
	initialSelectedChatKey?: string;
}

export function HarvestInspector({
	initialNotes,
	initialChats,
	initialSelectedChatKey = "",
}: HarvestInspectorProps) {
	const { client, subscribeEvents, connectionStatus } = useCadmus();

	const [chats, setChats] = useState<ChatRecord[]>(initialChats ?? []);
	const [selectedChatKey, setSelectedChatKey] = useState<string>(
		initialSelectedChatKey,
	);
	const [notes, setNotes] = useState<HarvestNote[]>(initialNotes ?? []);
	const [isLoading, setIsLoading] = useState<boolean>(false);
	const [error, setError] = useState<string | null>(null);

	// Load chats list and notes for selected chat or all chats
	const fetchHarvestNotes = useCallback(async () => {
		setIsLoading(true);
		setError(null);
		try {
			// 1. Fetch available chats
			const chatListRes = await client.callRpc("chat.list", {});
			let chatList = chats;
			if (chatListRes.ok && chatListRes.result?.chats) {
				chatList = chatListRes.result.chats;
				setChats(chatList);
			}

			// 2. Fetch notes according to chat filter
			if (selectedChatKey) {
				const singleRes = await client.callRpc("chat.get", {
					chatKey: selectedChatKey,
				});
				if (singleRes.ok && singleRes.result?.notes) {
					setNotes([...singleRes.result.notes].sort((a, b) => b.when - a.when));
				} else {
					setNotes([]);
				}
			} else {
				// Aggregate across all chats
				const allNotes: HarvestNote[] = [];
				const responses = await Promise.allSettled(
					chatList.map((c) => client.callRpc("chat.get", { chatKey: c.key })),
				);

				for (const res of responses) {
					if (
						res.status === "fulfilled" &&
						res.value.ok &&
						res.value.result?.notes
					) {
						for (const n of res.value.result.notes) {
							allNotes.push(n);
						}
					}
				}

				// Deduplicate by chatKey:at:when and sort descending
				const seen = new Set<string>();
				const uniqueNotes: HarvestNote[] = [];
				for (const n of allNotes) {
					const key = `${n.chatKey}:${n.at}:${n.when}`;
					if (!seen.has(key)) {
						seen.add(key);
						uniqueNotes.push(n);
					}
				}
				uniqueNotes.sort((a, b) => b.when - a.when);
				setNotes(uniqueNotes);
			}
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to load harvest history",
			);
		} finally {
			setIsLoading(false);
		}
	}, [client, chats, selectedChatKey]);

	// Load initial data if not provided
	useEffect(() => {
		if (initialNotes === undefined) {
			void fetchHarvestNotes();
		}
	}, [fetchHarvestNotes, initialNotes]);

	// Live subscription to harvest.note events over WebSocket
	useEffect(() => {
		const unsub = subscribeEvents((event: ServerEvent) => {
			if (event.type === "harvest.note") {
				const note = event.payload;
				setNotes((prev) => {
					// If filtering by specific chat and it doesn't match, skip
					if (selectedChatKey && note.chatKey !== selectedChatKey) {
						return prev;
					}
					// Deduplicate
					const exists = prev.some(
						(n) =>
							n.chatKey === note.chatKey &&
							n.at === note.at &&
							n.when === note.when,
					);
					if (exists) return prev;
					return [note, ...prev];
				});
			}
		});

		return unsub;
	}, [subscribeEvents, selectedChatKey]);

	return (
		<section className="harvest-pane" aria-label="Harvest Inspector">
			{/* Header Controls */}
			<div className="harvest-pane-header">
				<div
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						gap: "8px",
						flexWrap: "wrap",
					}}
				>
					<div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
						<span style={{ fontSize: "16px" }}>🌾</span>
						<h2
							style={{
								fontSize: "15px",
								fontWeight: 600,
								color: "var(--text-primary)",
							}}
						>
							Harvest Inspector
						</h2>
						<span className="badge badge-ghost">{`${notes.length} notes`}</span>
						<span
							className={`badge ${
								connectionStatus === "connected"
									? "badge-emerald"
									: "badge-ghost"
							}`}
							title="Live WebSocket sync for incoming idle harvest events"
						>
							Live WS
						</span>
					</div>

					<button
						type="button"
						className="btn btn-secondary btn-sm"
						onClick={fetchHarvestNotes}
						disabled={isLoading}
						title="Refresh harvest history"
					>
						↻ Refresh
					</button>
				</div>

				{/* Chat Filter */}
				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: "8px",
						flexWrap: "wrap",
					}}
				>
					<label
						htmlFor="harvest-chat-filter"
						style={{ fontSize: "12px", color: "var(--text-secondary)" }}
					>
						Chat Filter:
					</label>
					<select
						id="harvest-chat-filter"
						className="select"
						style={{ minWidth: "220px", height: "30px", fontSize: "12px" }}
						value={selectedChatKey}
						onChange={(e) => setSelectedChatKey(e.target.value)}
					>
						<option value="">All Chats</option>
						{chats.map((c) => (
							<option key={c.key} value={c.key}>
								{c.title || c.key} (#{c.key})
							</option>
						))}
					</select>
				</div>
			</div>

			{/* Main Notes List */}
			<div className="harvest-pane-content">
				{error && (
					<div
						className="alert-banner alert-error"
						style={{ marginBottom: "8px" }}
					>
						{error}
					</div>
				)}

				{notes.length === 0 ? (
					<div className="empty-state">
						<span className="empty-icon">🌾</span>
						<h3>No Harvest Notes</h3>
						<p>
							{selectedChatKey
								? `No harvest extractions recorded for chat "${selectedChatKey}" yet.`
								: "No conversation extractions recorded yet. Background idle harvest tasks inspect inactive chats and write memory/knowledge diffs here."}
						</p>
					</div>
				) : (
					notes.map((note) => {
						const noteDate = new Date(note.when);
						const formattedWhen = !Number.isNaN(noteDate.getTime())
							? noteDate.toLocaleString()
							: String(note.when);

						return (
							<article
								key={`${note.chatKey}-${note.at}-${note.when}`}
								className="harvest-card"
							>
								{/* Card Header */}
								<div className="harvest-card-header">
									<div className="harvest-card-title">
										<span>{`Chat: ${note.chatKey}`}</span>
										<span className="badge badge-cyan">
											{`Watermark: Entry #${note.at}`}
										</span>
										<span className="badge badge-indigo">
											{`${note.files.length} file(s)`}
										</span>
									</div>
									<div className="harvest-time">{formattedWhen}</div>
								</div>

								{/* Modified Files & Diffs */}
								<div className="harvest-card-body">
									{note.files.length === 0 ? (
										<div
											style={{
												fontSize: "12px",
												color: "var(--text-muted)",
												fontStyle: "italic",
											}}
										>
											No file modifications recorded in this harvest run.
										</div>
									) : (
										note.files.map((file) => (
											<div key={file.path} className="harvest-file-diff-item">
												<div className="harvest-file-header">
													<span className="badge badge-indigo">
														{file.path}
													</span>
												</div>
												<UnifiedDiffViewer diff={file.diff} />
											</div>
										))
									)}
								</div>
							</article>
						);
					})
				)}
			</div>
		</section>
	);
}
