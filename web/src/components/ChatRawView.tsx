import { useMemo, useState } from "react";
import type {
	RawTranscriptEntry,
	ServerEvent,
	TranscriptMessageView,
} from "../../../src/protocol.js";
import { useAutoScroll } from "../hooks/useAutoScroll.js";

export interface ChatRawViewProps {
	entries: RawTranscriptEntry[];
	messages: TranscriptMessageView[];
	liveEvents: ServerEvent[];
	chatKey?: string;
}

interface RawModelMessage {
	role?: string;
	content?: unknown;
	timestamp?: number;
	durationMs?: number;
	provider?: string;
	model?: string;
	api?: string;
	thinkingLevel?: string;
	stopReason?: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	usage?: {
		input?: number;
		output?: number;
		reasoning?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		cost?: { total?: number | string };
		[key: string]: unknown;
	};
	sections?: Record<string, string>;
	toolsAdded?: Array<{
		name: string;
		description?: string;
		parameters?: unknown;
	}>;
}

function normalizeKind(kind: string): string {
	const k = kind.replace(/^pi\./, "").toLowerCase().replace(/[-_]/g, "");
	if (k === "system") return "system";
	if (k === "user") return "user";
	if (k === "assistant") return "assistant";
	if (k === "toolresult") return "toolResult";
	return kind;
}

function triggerBlobDownload(
	content: string,
	filename: string,
	mimeType = "application/x-jsonlines",
) {
	if (typeof window === "undefined" || typeof document === "undefined") {
		return;
	}
	const blob = new Blob([content], { type: mimeType });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

export function ChatRawView({
	entries,
	messages: _messages,
	liveEvents,
	chatKey,
}: ChatRawViewProps) {
	const { scrollRef, handleScroll } = useAutoScroll<HTMLDivElement>({
		chatKey,
	});

	const [filterKind, setFilterKind] = useState<string>("all");
	const [showAllJson, setShowAllJson] = useState<boolean>(false);
	const [expandedRawIds, setExpandedRawIds] = useState<Set<number>>(new Set());

	// Count breakdown
	const counts = useMemo(() => {
		const res = {
			system: 0,
			user: 0,
			assistant: 0,
			toolResult: 0,
			other: 0,
		};
		for (const entry of entries) {
			const k = normalizeKind(entry.kind);
			if (k === "system") res.system++;
			else if (k === "user") res.user++;
			else if (k === "assistant") res.assistant++;
			else if (k === "toolResult") res.toolResult++;
			else res.other++;
		}
		return res;
	}, [entries]);

	const filteredEntries = useMemo(() => {
		if (filterKind === "all") return entries;
		return entries.filter((e) => normalizeKind(e.kind) === filterKind);
	}, [entries, filterKind]);

	const toggleRawJson = (id: number) => {
		setExpandedRawIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	};

	const getKindBadgeClass = (kind: string) => {
		const k = normalizeKind(kind);
		switch (k) {
			case "user":
				return "badge-indigo";
			case "assistant":
				return "badge-emerald";
			case "system":
				return "badge-cyan";
			case "toolResult":
				return "badge-amber";
			case "compaction":
			case "reset":
				return "badge-rose";
			default:
				return "badge-ghost";
		}
	};

	return (
		<div className="raw-view-container">
			{/* Top Toolbar */}
			<div className="raw-toolbar">
				<div className="raw-toolbar-counts">
					<span className="badge badge-ghost">{`Total: ${entries.length}`}</span>
					<span className="badge badge-cyan">{`system: ${counts.system}`}</span>
					<span className="badge badge-indigo">{`user: ${counts.user}`}</span>
					<span className="badge badge-emerald">
						{`assistant: ${counts.assistant}`}
					</span>
					<span className="badge badge-amber">
						{`toolResult: ${counts.toolResult}`}
					</span>
					{counts.other > 0 && (
						<span className="badge badge-ghost">{`other: ${counts.other}`}</span>
					)}
				</div>

				<div className="raw-toolbar-controls">
					<div className="segmented-control">
						{["all", "system", "user", "assistant", "toolResult"].map((k) => (
							<button
								key={k}
								type="button"
								className={`segmented-item ${filterKind === k ? "active" : ""}`}
								onClick={() => setFilterKind(k)}
							>
								{k}
							</button>
						))}
					</div>

					<button
						type="button"
						className={`btn btn-sm ${showAllJson ? "btn-primary" : "btn-secondary"}`}
						onClick={() => setShowAllJson(!showAllJson)}
					>
						{showAllJson
							? "Hide Raw JSON for All"
							: "{ } Show Raw JSON for All"}
					</button>

					<button
						type="button"
						className="btn btn-secondary btn-sm"
						onClick={() => {
							const jsonlContent =
								entries.map((entry) => JSON.stringify(entry)).join("\n") +
								(entries.length > 0 ? "\n" : "");
							const safeKey = (chatKey ?? "chat").replace(
								/[^a-zA-Z0-9_-]/g,
								"_",
							);
							const dateStamp = new Date().toISOString().slice(0, 10);
							const filename = `${safeKey}-transcript-${dateStamp}.jsonl`;
							triggerBlobDownload(
								jsonlContent,
								filename,
								"application/x-jsonlines",
							);
						}}
						title="Export transcript as JSONL file"
					>
						Export JSONL
					</button>
				</div>
			</div>

			{/* Entries List */}
			<div
				className="raw-entries-scroll"
				ref={scrollRef}
				onScroll={handleScroll}
			>
				{filteredEntries.length === 0 && (
					<div className="empty-state">
						<span className="empty-icon">🔍</span>
						<h3>No Transcript Entries</h3>
						<p>No entries match the selected filter "{filterKind}".</p>
					</div>
				)}

				{filteredEntries.map((entry) => {
					const isRawJsonOpen = showAllJson || expandedRawIds.has(entry.id);
					const modelMessages = Array.isArray(entry.model)
						? (entry.model as RawModelMessage[])
						: [];

					return (
						<div key={entry.id} className="raw-entry-card">
							{/* Entry Header */}
							<div className="raw-entry-header">
								<div className="raw-entry-title">
									<strong style={{ fontSize: "14px" }}>
										{`Entry #${entry.id}`}
									</strong>
									<span className={`badge ${getKindBadgeClass(entry.kind)}`}>
										{`kind: ${entry.kind}`}
									</span>
									<span className="badge badge-ghost">
										{`convId: #${entry.conversationId}`}
									</span>
									{entry.head !== undefined && (
										<span className="badge badge-ghost">
											{`head: #${entry.head}`}
										</span>
									)}
									{entry.byTaskId !== undefined && (
										<span className="badge badge-ghost">
											{`taskId: #${entry.byTaskId}`}
										</span>
									)}
								</div>

								<button
									type="button"
									className="btn btn-sm btn-ghost"
									onClick={() => toggleRawJson(entry.id)}
									style={{ fontFamily: "var(--font-mono)", fontSize: "11px" }}
								>
									{isRawJsonOpen ? "Hide JSON ▲" : "{ } Raw JSON ▼"}
								</button>
							</div>

							{/* Low-Level Model Messages */}
							{modelMessages.length > 0 && (
								<div className="raw-models-container">
									{modelMessages.map((msg) => {
										const msgKey = `${entry.id}-${msg.role ?? "msg"}-${msg.timestamp ?? msg.toolCallId ?? "0"}`;
										return (
											<div key={msgKey} className="raw-model-message">
												{/* Message Header Bar */}
												<div className="raw-model-header-bar">
													<span
														className={`badge ${getKindBadgeClass(msg.role ?? "ghost")}`}
													>
														role: {msg.role ?? "unknown"}
													</span>
													{msg.timestamp && (
														<span className="raw-meta-item">
															{new Date(msg.timestamp).toISOString()} (
															{msg.timestamp})
														</span>
													)}
													{msg.durationMs !== undefined && (
														<span className="raw-meta-item">
															{msg.durationMs}ms
														</span>
													)}
													{msg.provider && (
														<span className="raw-meta-item">
															provider: <strong>{msg.provider}</strong>
														</span>
													)}
													{msg.model && (
														<span className="raw-meta-item">
															model: <strong>{msg.model}</strong>
														</span>
													)}
													{msg.api && (
														<span className="raw-meta-item">
															api: {msg.api}
														</span>
													)}
													{msg.thinkingLevel && (
														<span className="raw-meta-item">
															thinking: {msg.thinkingLevel}
														</span>
													)}
													{msg.stopReason && (
														<span className="raw-meta-item">
															stop: {msg.stopReason}
														</span>
													)}
													{msg.toolCallId && (
														<span className="raw-meta-item">
															toolCallId: <strong>{msg.toolCallId}</strong>
														</span>
													)}
													{msg.toolName && (
														<span className="raw-meta-item">
															toolName: <strong>{msg.toolName}</strong>
														</span>
													)}
													{msg.isError !== undefined && (
														<span
															className={`badge ${msg.isError ? "badge-rose" : "badge-emerald"}`}
														>
															isError: {String(msg.isError)}
														</span>
													)}
												</div>

												{/* Usage & Cost Table */}
												{msg.usage && (
													<div className="raw-usage-section">
														<div className="inner-block-title">
															Token &amp; Cost Metrics
														</div>
														<div className="raw-usage-table-wrapper">
															<table className="raw-usage-table">
																<thead>
																	<tr>
																		<th>Input</th>
																		<th>Output</th>
																		<th>Reasoning</th>
																		<th>Cache Read</th>
																		<th>Cache Write</th>
																		<th>Total</th>
																		<th>Cost Total</th>
																	</tr>
																</thead>
																<tbody>
																	<tr>
																		<td>{String(msg.usage.input ?? "-")}</td>
																		<td>{String(msg.usage.output ?? "-")}</td>
																		<td>
																			{String(msg.usage.reasoning ?? "-")}
																		</td>
																		<td>
																			{String(msg.usage.cacheRead ?? "-")}
																		</td>
																		<td>
																			{String(msg.usage.cacheWrite ?? "-")}
																		</td>
																		<td>
																			{String(msg.usage.totalTokens ?? "-")}
																		</td>
																		<td>
																			{typeof msg.usage.cost === "object" &&
																			msg.usage.cost &&
																			"total" in msg.usage.cost
																				? String(
																						(
																							msg.usage.cost as {
																								total?: number | string;
																							}
																						).total,
																					)
																				: "-"}
																		</td>
																	</tr>
																</tbody>
															</table>
														</div>
													</div>
												)}

												{/* Inner Content Blocks */}
												<div className="raw-inner-blocks">
													{/* System Prompt Sections */}
													{msg.role === "system" &&
														msg.sections &&
														typeof msg.sections === "object" && (
															<div className="sections-container">
																<div className="inner-block-title">
																	{`System Sections (${Object.keys(msg.sections).length})`}
																</div>
																{Object.entries(msg.sections).map(
																	([secName, secContent]) => (
																		<details
																			key={secName}
																			className="inner-block-card"
																			open
																		>
																			<summary className="inner-block-header">
																				<span>{`Section: [${secName}]`}</span>
																				<span className="badge badge-ghost">
																					{typeof secContent === "string"
																						? `${secContent.length} chars`
																						: "cleared"}
																				</span>
																			</summary>
																			<pre className="code-block">
																				{secContent ?? "(cleared)"}
																			</pre>
																		</details>
																	),
																)}
															</div>
														)}

													{/* System Declared Tools */}
													{msg.role === "system" &&
														Array.isArray(msg.toolsAdded) &&
														msg.toolsAdded.length > 0 && (
															<div className="declared-tools-container">
																<div className="inner-block-title">
																	{`Declared Tools (${msg.toolsAdded.length})`}
																</div>
																{msg.toolsAdded.map((tool) => (
																	<details
																		key={tool.name}
																		className="inner-block-card"
																	>
																		<summary className="inner-block-header">
																			<span>{`⚙️ ${tool.name}`}</span>
																			<span className="badge badge-cyan">
																				{tool.description ?? "no description"}
																			</span>
																		</summary>
																		<pre className="code-block">
																			{JSON.stringify(tool.parameters, null, 2)}
																		</pre>
																	</details>
																))}
															</div>
														)}

													{/* Array of Inner Blocks */}
													{Array.isArray(msg.content) && (
														<div className="blocks-array-container">
															<div className="inner-block-title">
																{`Inner Blocks (${msg.content.length})`}
															</div>
															{msg.content.map(
																(blockItem: unknown, blockIndex: number) => {
																	const block =
																		typeof blockItem === "object" &&
																		blockItem !== null
																			? (blockItem as Record<string, unknown>)
																			: { type: "unknown" };
																	const blockType = String(
																		block.type ?? "unknown",
																	);
																	const bId = String(
																		block.id ??
																			block.name ??
																			blockType + blockIndex,
																	);
																	return (
																		<div
																			key={`${entry.id}-${blockType}-${bId}`}
																			className="inner-block-card"
																		>
																			<div className="inner-block-header">
																				<span>
																					{`Block [${blockIndex}] — type: "${blockType}"`}
																				</span>
																				{Boolean(block.redacted) && (
																					<span className="badge badge-rose">
																						Redacted
																					</span>
																				)}
																			</div>
																			<div className="inner-block-body">
																				{blockType === "thinking" && (
																					<div>
																						<pre className="code-block">
																							{String(block.thinking ?? "")}
																						</pre>
																						{Boolean(
																							block.thinkingSignature,
																						) && (
																							<div className="raw-signature-box">
																								signature:{" "}
																								{String(
																									block.thinkingSignature,
																								)}
																							</div>
																						)}
																					</div>
																				)}

																				{blockType === "toolCall" && (
																					<div>
																						<div className="tool-call-submeta">
																							<span>
																								id:{" "}
																								<strong>
																									{String(block.id ?? "")}
																								</strong>
																							</span>
																							<span>
																								name:{" "}
																								<strong>
																									{String(block.name ?? "")}
																								</strong>
																							</span>
																						</div>
																						<div className="tool-section-label">
																							Arguments:
																						</div>
																						<pre className="code-block">
																							{JSON.stringify(
																								block.arguments,
																								null,
																								2,
																							)}
																						</pre>
																						{Boolean(block.argumentsError) && (
																							<div className="tool-args-error">
																								argumentsError:{" "}
																								{String(block.argumentsError)}
																							</div>
																						)}
																					</div>
																				)}

																				{blockType === "text" && (
																					<div>
																						<pre className="code-block">
																							{String(block.text ?? "")}
																						</pre>
																						{Boolean(block.textSignature) && (
																							<div className="raw-signature-box">
																								signature:{" "}
																								{String(block.textSignature)}
																							</div>
																						)}
																					</div>
																				)}

																				{blockType === "image" && (
																					<div>
																						<span className="badge badge-cyan">
																							mime:{" "}
																							{String(block.mimeType ?? "")}
																						</span>
																						<span className="badge badge-ghost">
																							data size:{" "}
																							{typeof block.data === "string"
																								? block.data.length
																								: 0}{" "}
																							chars
																						</span>
																					</div>
																				)}
																			</div>
																		</div>
																	);
																},
															)}
														</div>
													)}

													{/* Plain String Content */}
													{typeof msg.content === "string" && (
														<div className="inner-block-card">
															<div className="inner-block-header">
																Block [0] — type: "string"
															</div>
															<div className="inner-block-body">
																<pre className="code-block">{msg.content}</pre>
															</div>
														</div>
													)}

													{/* Object Content */}
													{typeof msg.content === "object" &&
														msg.content !== null &&
														!Array.isArray(msg.content) && (
															<div className="inner-block-card">
																<div className="inner-block-header">
																	Block [0] — type: "object"
																</div>
																<div className="inner-block-body">
																	<pre className="code-block">
																		{JSON.stringify(msg.content, null, 2)}
																	</pre>
																</div>
															</div>
														)}
												</div>
											</div>
										);
									})}
								</div>
							)}

							{/* Entry Diagnostics / Data payload */}
							{entry.data !== undefined && (
								<div className="entry-data-section">
									<div className="inner-block-title">
										Entry Data / Diagnostics
									</div>
									<pre className="code-block">
										{JSON.stringify(entry.data, null, 2)}
									</pre>
								</div>
							)}

							{/* Raw JSON View */}
							{isRawJsonOpen && (
								<div className="entry-raw-json">
									<div className="inner-block-title">
										Raw JSON Transcript Entry
									</div>
									<pre className="code-block">
										{JSON.stringify(entry, null, 2)}
									</pre>
								</div>
							)}
						</div>
					);
				})}
			</div>

			{/* Collapsible Live Stream Frames */}
			{liveEvents.length > 0 && (
				<details className="live-events-details">
					<summary className="live-events-summary">
						<span>{`⚡ Live Stream Frames (${liveEvents.length})`}</span>
						<span className="badge badge-cyan">WebSocket</span>
					</summary>
					<div className="live-events-body">
						{liveEvents.map((ev) => {
							const evKey = `${ev.type}-${JSON.stringify(ev.payload).slice(0, 30)}`;
							return (
								<div key={evKey} className="live-event-row">
									<div className="live-event-header">
										<span className="badge badge-emerald">{ev.type}</span>
									</div>
									<pre className="code-block">
										{JSON.stringify(ev, null, 2)}
									</pre>
								</div>
							);
						})}
					</div>
				</details>
			)}
		</div>
	);
}
