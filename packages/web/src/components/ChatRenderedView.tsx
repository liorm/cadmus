import type {
	HarvestNote,
	TranscriptContentBlock,
	TranscriptMessageView,
	TranscriptToolCallView,
} from "@cadmus/contract/types";
import { useRef } from "react";
import { useAutoScroll } from "../hooks/useAutoScroll.js";

export interface ChatRenderedViewProps {
	messages: TranscriptMessageView[];
	notes: HarvestNote[];
	streamingState: {
		active: boolean;
		thinking: string;
		text: string;
		toolCalls: Array<{
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
			result?: { content: string; isError: boolean };
		}>;
	};
	botMessages?: Array<{
		fromBotId: string;
		toBotId: string;
		text: string;
		reply?: string;
		when: number;
	}>;
	chatKey?: string;
}

// ─── Lightweight Safe Markdown Renderer ───────────────────────────────────────

function parseInlineMarkdown(text: string): React.ReactNode[] {
	const parts: React.ReactNode[] = [];
	const regex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
	let lastIndex = 0;
	let match = regex.exec(text);
	let key = 0;

	while (match !== null) {
		if (match.index > lastIndex) {
			parts.push(text.slice(lastIndex, match.index));
		}
		const token = match[0];
		if (token.startsWith("`") && token.endsWith("`")) {
			key += 1;
			parts.push(
				<code key={`code-${key}`} className="inline-code">
					{token.slice(1, -1)}
				</code>,
			);
		} else if (token.startsWith("**") && token.endsWith("**")) {
			key += 1;
			parts.push(<strong key={`bold-${key}`}>{token.slice(2, -2)}</strong>);
		} else if (token.startsWith("*") && token.endsWith("*")) {
			key += 1;
			parts.push(<em key={`em-${key}`}>{token.slice(1, -1)}</em>);
		}
		lastIndex = regex.lastIndex;
		match = regex.exec(text);
	}
	if (lastIndex < text.length) {
		parts.push(text.slice(lastIndex));
	}
	return parts;
}

function renderTextParagraphs(
	text: string,
	nodes: React.ReactNode[],
	startKey: number,
) {
	const paragraphs = text.split(/\n\n+/);
	let k = startKey;
	for (const para of paragraphs) {
		const trimmed = para.trim();
		if (!trimmed) continue;

		if (trimmed.startsWith("### ")) {
			const nl = trimmed.indexOf("\n");
			if (nl !== -1) {
				nodes.push(
					<h3 key={`h3-${k++}`}>
						{parseInlineMarkdown(trimmed.slice(4, nl))}
					</h3>,
				);
				renderTextParagraphs(trimmed.slice(nl + 1), nodes, k);
				k += 10;
			} else {
				nodes.push(
					<h3 key={`h3-${k++}`}>{parseInlineMarkdown(trimmed.slice(4))}</h3>,
				);
			}
		} else if (trimmed.startsWith("## ")) {
			const nl = trimmed.indexOf("\n");
			if (nl !== -1) {
				nodes.push(
					<h2 key={`h2-${k++}`}>
						{parseInlineMarkdown(trimmed.slice(3, nl))}
					</h2>,
				);
				renderTextParagraphs(trimmed.slice(nl + 1), nodes, k);
				k += 10;
			} else {
				nodes.push(
					<h2 key={`h2-${k++}`}>{parseInlineMarkdown(trimmed.slice(3))}</h2>,
				);
			}
		} else if (trimmed.startsWith("# ")) {
			const nl = trimmed.indexOf("\n");
			if (nl !== -1) {
				nodes.push(
					<h1 key={`h1-${k++}`}>
						{parseInlineMarkdown(trimmed.slice(2, nl))}
					</h1>,
				);
				renderTextParagraphs(trimmed.slice(nl + 1), nodes, k);
				k += 10;
			} else {
				nodes.push(
					<h1 key={`h1-${k++}`}>{parseInlineMarkdown(trimmed.slice(2))}</h1>,
				);
			}
		} else if (trimmed.startsWith("> ")) {
			nodes.push(
				<blockquote key={`bq-${k++}`}>
					{parseInlineMarkdown(trimmed.slice(2))}
				</blockquote>,
			);
		} else {
			const lines = trimmed.split("\n");
			const isList = lines.every((l) => /^\s*[-*]\s+/.test(l));
			if (isList) {
				nodes.push(
					<ul key={`ul-${k++}`} className="markdown-list">
						{lines.map((l) => {
							const itemText = l.replace(/^\s*[-*]\s+/, "");
							return <li key={itemText}>{parseInlineMarkdown(itemText)}</li>;
						})}
					</ul>,
				);
			} else {
				let lineCounter = 0;
				nodes.push(
					<p key={`p-${k++}`}>
						{lines.map((line) => {
							lineCounter += 1;
							return (
								<span key={`l-${k}-${lineCounter}`}>
									{lineCounter > 1 && <br />}
									{parseInlineMarkdown(line)}
								</span>
							);
						})}
					</p>,
				);
			}
		}
	}
}

export function RenderedMarkdown({ text }: { text: string }) {
	if (!text) return null;

	const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
	const nodes: React.ReactNode[] = [];
	let lastIndex = 0;
	let match = codeBlockRegex.exec(text);
	let blockKey = 0;

	while (match !== null) {
		if (match.index > lastIndex) {
			const precedingText = text.slice(lastIndex, match.index);
			renderTextParagraphs(precedingText, nodes, blockKey);
			blockKey += 100;
		}

		const lang = match[1] || "";
		const code = match[2];
		nodes.push(
			<pre key={`cb-${blockKey++}`} className="code-block">
				<code className={lang ? `language-${lang}` : undefined}>{code}</code>
			</pre>,
		);
		lastIndex = codeBlockRegex.lastIndex;
		match = codeBlockRegex.exec(text);
	}

	if (lastIndex < text.length) {
		const remaining = text.slice(lastIndex);
		renderTextParagraphs(remaining, nodes, blockKey);
	}

	return <div className="rendered-markdown">{nodes}</div>;
}

// ─── Sub-Components ──────────────────────────────────────────────────────────

function ThinkingAccordion({
	thinking,
	defaultOpen = false,
	title = "🧠 Thinking / Reasoning",
}: {
	thinking: string;
	defaultOpen?: boolean;
	title?: string;
}) {
	return (
		<details className="thinking-accordion" open={defaultOpen}>
			<summary className="thinking-summary">{title}</summary>
			<pre className="thinking-content">{thinking}</pre>
		</details>
	);
}

function ToolCallCard({
	toolCall,
	defaultOpen = false,
}: {
	toolCall:
		| TranscriptToolCallView
		| {
				id?: string;
				toolCallId?: string;
				name?: string;
				toolName?: string;
				arguments?: unknown;
				args?: Record<string, unknown>;
				result?: { content: string; isError: boolean; durationMs?: number };
		  };
	defaultOpen?: boolean;
}) {
	const name =
		"name" in toolCall && toolCall.name
			? toolCall.name
			: (toolCall as { toolName?: string }).toolName || "tool";
	const id =
		"id" in toolCall && toolCall.id
			? toolCall.id
			: (toolCall as { toolCallId?: string }).toolCallId || "";
	const args =
		"arguments" in toolCall
			? toolCall.arguments
			: (toolCall as { args?: Record<string, unknown> }).args || {};
	const result = toolCall.result;

	return (
		<details className="tool-call-card" open={defaultOpen ? true : undefined}>
			<summary className="tool-call-header">
				<span className="tool-icon">⚙️</span>
				<span className="tool-name">{name}</span>
				{id && <span className="tool-id">{`#${id}`}</span>}
				<div className="tool-header-meta">
					{result && (
						<span
							className={`badge ${result.isError ? "badge-rose" : "badge-emerald"}`}
						>
							{result.isError ? "Error" : "OK"}
						</span>
					)}
					<span className="badge badge-ghost tool-chevron">▼</span>
				</div>
			</summary>
			<div className="tool-call-body">
				{id && <div className="tool-id-expanded">{`Call ID: #${id}`}</div>}
				<div className="tool-section-label">Arguments:</div>
				<pre className="code-block">{JSON.stringify(args, null, 2)}</pre>
				{result && (
					<div className="tool-result-section">
						<div className="tool-result-header">
							<span className="tool-section-label">Result:</span>
							{result.durationMs !== undefined && (
								<span className="badge badge-ghost">{result.durationMs}ms</span>
							)}
						</div>
						<pre className="code-block">{result.content}</pre>
					</div>
				)}
			</div>
		</details>
	);
}

function HarvestNoteCard({ note }: { note: HarvestNote }) {
	return (
		<details className="harvest-note-card">
			<summary className="harvest-note-header">
				<span className="harvest-icon">🌱</span>
				<span className="harvest-title">
					Harvested memory/knowledge at entry <strong>{`#${note.at}`}</strong>
				</span>
				<span className="badge badge-cyan">{`${note.files.length} files`}</span>
				<span className="harvest-time">
					{new Date(note.when).toLocaleTimeString()}
				</span>
				<span className="badge badge-ghost" style={{ marginLeft: "auto" }}>
					Diffs ▼
				</span>
			</summary>
			<div className="harvest-note-body">
				{note.files.map((file) => (
					<details key={file.path} className="harvest-diff-details" open>
						<summary className="harvest-diff-summary">
							<code>{file.path}</code>
						</summary>
						<pre className="diff-view">{file.diff}</pre>
					</details>
				))}
			</div>
		</details>
	);
}

interface MergedTranscriptMessageView extends TranscriptMessageView {
	mergedEntryIds?: number[];
}

function isMessageWithoutText(msg: TranscriptMessageView): boolean {
	if (msg.role !== "assistant") return false;
	if (msg.text && msg.text.trim().length > 0) return false;
	if (msg.blocks?.some((b) => b.type === "text" && b.text.trim().length > 0)) {
		return false;
	}
	return true;
}

function mergeAssistantInto(
	target: MergedTranscriptMessageView,
	source: TranscriptMessageView,
) {
	// Track merged IDs for harvest notes / metadata
	target.mergedEntryIds = [
		...(target.mergedEntryIds ?? [target.id]),
		source.id,
	];

	// Combine tool calls
	if (source.toolCalls && source.toolCalls.length > 0) {
		target.toolCalls = [...(target.toolCalls ?? []), ...source.toolCalls];
	}

	// Combine structured blocks if either has blocks
	if (target.blocks || source.blocks) {
		const targetBlocks: TranscriptContentBlock[] = target.blocks
			? [...target.blocks]
			: [];
		if (!target.blocks) {
			if (target.thinking) {
				targetBlocks.push({ type: "thinking", thinking: target.thinking });
			}
			if (target.toolCalls) {
				for (const tc of target.toolCalls) {
					targetBlocks.push({
						type: "toolCall",
						id: tc.id,
						name: tc.name,
						arguments: tc.arguments,
						result: tc.result,
					});
				}
			}
			if (target.text) {
				targetBlocks.push({ type: "text", text: target.text });
			}
		}

		if (source.blocks) {
			targetBlocks.push(...source.blocks);
		} else {
			if (source.thinking) {
				targetBlocks.push({ type: "thinking", thinking: source.thinking });
			}
			if (source.toolCalls) {
				for (const tc of source.toolCalls) {
					targetBlocks.push({
						type: "toolCall",
						id: tc.id,
						name: tc.name,
						arguments: tc.arguments,
						result: tc.result,
					});
				}
			}
			if (source.text) {
				targetBlocks.push({ type: "text", text: source.text });
			}
		}
		target.blocks = targetBlocks;
	} else {
		if (source.thinking) {
			target.thinking = target.thinking
				? `${target.thinking}\n\n${source.thinking}`
				: source.thinking;
		}
		if (source.text && source.text.trim().length > 0) {
			target.text = target.text
				? `${target.text}\n\n${source.text}`
				: source.text;
		}
	}

	// Aggregate duration and latest usage
	if (source.durationMs !== undefined) {
		target.durationMs = (target.durationMs ?? 0) + source.durationMs;
	}
	if (source.usage) {
		target.usage = source.usage;
	}
}

function processDisplayMessages(
	messages: TranscriptMessageView[],
	boundToolCallIds: Set<string>,
): MergedTranscriptMessageView[] {
	// Filter out standalone toolResult messages if already bound
	const filtered = messages.filter((msg) => {
		if (msg.role === "toolResult" && msg.toolCallId) {
			if (boundToolCallIds.has(msg.toolCallId)) {
				return false;
			}
		}
		return true;
	});

	const result: MergedTranscriptMessageView[] = [];

	for (const msg of filtered) {
		if (msg.role === "assistant") {
			const prev = result[result.length - 1];
			if (prev && prev.role === "assistant") {
				// If current message is without text, merge into previous assistant message
				if (isMessageWithoutText(msg)) {
					mergeAssistantInto(prev, msg);
					continue;
				}
				// If previous assistant message was without text, merge into it as well
				if (isMessageWithoutText(prev)) {
					mergeAssistantInto(prev, msg);
					continue;
				}
			}
		}

		// Clone msg into result
		result.push({ ...msg });
	}

	return result;
}

function AssistantMessageContent({ msg }: { msg: TranscriptMessageView }) {
	// If server provided structured content blocks
	if (msg.blocks && msg.blocks.length > 0) {
		const rendered: React.ReactNode[] = [];
		let currentToolCalls: Extract<
			TranscriptContentBlock,
			{ type: "toolCall" }
		>[] = [];
		let keyCounter = 0;

		const flushToolCalls = () => {
			if (currentToolCalls.length === 0) return;
			const calls = currentToolCalls;
			currentToolCalls = [];
			rendered.push(
				<div key={`tool-chips-${keyCounter++}`} className="tool-chips-row">
					{calls.map((block) => (
						<ToolCallCard
							key={block.id}
							toolCall={{
								id: block.id,
								name: block.name,
								arguments: block.arguments,
								result: block.result,
							}}
						/>
					))}
				</div>,
			);
		};

		for (const block of msg.blocks) {
			if (block.type === "toolCall") {
				currentToolCalls.push(block);
			} else {
				flushToolCalls();
				keyCounter += 1;
				if (block.type === "thinking") {
					rendered.push(
						<ThinkingAccordion
							key={`thinking-${keyCounter}`}
							thinking={block.thinking}
							title={
								block.redacted
									? "🧠 Thinking (Safety Redacted)"
									: "🧠 Thinking / Reasoning"
							}
						/>,
					);
				} else if (block.type === "text") {
					rendered.push(
						<RenderedMarkdown key={`text-${keyCounter}`} text={block.text} />,
					);
				} else if (block.type === "image") {
					const src =
						block.data.startsWith("http") || block.data.startsWith("data:")
							? block.data
							: `data:${block.mimeType};base64,${block.data}`;
					rendered.push(
						<div
							key={`image-${block.mimeType}-${keyCounter}`}
							className="image-block"
						>
							<img src={src} alt="Message visual output" />
						</div>,
					);
				}
			}
		}
		flushToolCalls();

		return <div className="assistant-blocks-container">{rendered}</div>;
	}

	// Fallback to separate thinking, toolCalls, and text
	return (
		<div className="assistant-blocks-container">
			{msg.thinking && <ThinkingAccordion thinking={msg.thinking} />}
			{msg.toolCalls && msg.toolCalls.length > 0 && (
				<div className="tool-chips-row">
					{msg.toolCalls.map((tc) => (
						<ToolCallCard key={tc.id} toolCall={tc} />
					))}
				</div>
			)}
			{msg.text && <RenderedMarkdown text={msg.text} />}
		</div>
	);
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function ChatRenderedView({
	messages,
	notes,
	streamingState,
	botMessages,
	chatKey,
}: ChatRenderedViewProps) {
	const prevMessagesLengthRef = useRef(messages.length);
	const hasNewUserMessage =
		messages.length > prevMessagesLengthRef.current &&
		messages[messages.length - 1]?.role === "user";
	prevMessagesLengthRef.current = messages.length;

	const { scrollRef, handleScroll } = useAutoScroll<HTMLDivElement>({
		chatKey,
		streamingActive: streamingState.active,
		hasNewUserMessage,
	});

	// Gather all toolCallIds bound onto assistant messages
	const boundToolCallIds = new Set<string>();
	for (const msg of messages) {
		if (msg.role === "assistant") {
			if (msg.toolCalls) {
				for (const tc of msg.toolCalls) {
					boundToolCallIds.add(tc.id);
				}
			}
			if (msg.blocks) {
				for (const b of msg.blocks) {
					if (b.type === "toolCall") {
						boundToolCallIds.add(b.id);
					}
				}
			}
		}
	}

	// Index harvest notes by entry watermark `at`
	const notesByAt = new Map<number, HarvestNote[]>();
	for (const note of notes) {
		const list = notesByAt.get(note.at) ?? [];
		list.push(note);
		notesByAt.set(note.at, list);
	}

	// Process messages: filter bound toolResult messages and merge assistant turns without text
	const displayMessages = processDisplayMessages(messages, boundToolCallIds);

	const isStreamingActive =
		streamingState.active ||
		Boolean(streamingState.thinking) ||
		Boolean(streamingState.text) ||
		streamingState.toolCalls.length > 0;

	return (
		<div
			className="chat-messages-scroll"
			ref={scrollRef}
			onScroll={handleScroll}
		>
			{displayMessages.length === 0 && !isStreamingActive && (
				<div className="empty-state">
					<span className="empty-icon">💬</span>
					<h3>No Messages Yet</h3>
					<p>Type a prompt below to begin chatting with this bot.</p>
				</div>
			)}

			{/* Render Messages & Inline Harvest Notes */}
			{displayMessages.map((msg) => {
				const entryIds = msg.mergedEntryIds ?? [msg.id];
				const entryNotes = entryIds.flatMap((id) => notesByAt.get(id) ?? []);

				if (msg.role === "user") {
					return (
						<div key={msg.id} className="chat-message-row user">
							<div className="message-meta user">
								<span className="badge badge-indigo">{`#${msg.id}`}</span>
								{msg.timestamp && (
									<span className="message-time">
										{new Date(msg.timestamp).toLocaleTimeString()}
									</span>
								)}
							</div>
							<div className="message-bubble user">
								<RenderedMarkdown text={msg.text} />
							</div>
							{entryNotes.map((note) => (
								<HarvestNoteCard
									key={`note-${note.at}-${note.when}`}
									note={note}
								/>
							))}
						</div>
					);
				}

				if (msg.role === "assistant") {
					const totalTokens = msg.usage
						? (msg.usage.totalTokens ??
							Number(msg.usage.input ?? 0) + Number(msg.usage.output ?? 0))
						: undefined;

					return (
						<div key={msg.id} className="chat-message-row assistant">
							<div className="message-meta assistant">
								<span className="badge badge-emerald">Assistant</span>
								<span className="badge badge-ghost">{`#${msg.id}`}</span>
								{msg.replyToEntryId !== undefined && (
									<span className="badge badge-indigo">
										{`↪ reply to #${msg.replyToEntryId}`}
									</span>
								)}
								{msg.model && (
									<span className="badge badge-cyan">{msg.model}</span>
								)}
								{msg.durationMs !== undefined && (
									<span className="badge badge-ghost">{`${msg.durationMs}ms`}</span>
								)}
								{totalTokens !== undefined && (
									<span className="badge badge-ghost" title="Token usage">
										{`${totalTokens} tokens`}
									</span>
								)}
								{msg.timestamp && (
									<span className="message-time">
										{new Date(msg.timestamp).toLocaleTimeString()}
									</span>
								)}
							</div>

							<div className="message-bubble assistant">
								<AssistantMessageContent msg={msg} />
							</div>

							{entryNotes.map((note) => (
								<HarvestNoteCard
									key={`note-${note.at}-${note.when}`}
									note={note}
								/>
							))}
						</div>
					);
				}

				if (msg.role === "toolResult") {
					// Fallback for unbound tool result
					return (
						<div key={msg.id} className="chat-message-row assistant">
							<div className="message-meta assistant">
								<span className="badge badge-amber">Tool Result</span>
								<span className="badge badge-ghost">{`#${msg.id}`}</span>
								<span className="badge badge-cyan">
									{msg.toolName || "tool"}
								</span>
								{msg.toolCallId && (
									<span className="badge badge-ghost">{`#${msg.toolCallId}`}</span>
								)}
								<span
									className={`badge ${msg.isError ? "badge-rose" : "badge-emerald"}`}
								>
									{msg.isError ? "Error" : "OK"}
								</span>
								{msg.durationMs !== undefined && (
									<span className="badge badge-ghost">{`${msg.durationMs}ms`}</span>
								)}
							</div>
							<div className="message-bubble assistant">
								<pre
									className={`code-block ${msg.isError ? "tool-error" : ""}`}
								>
									{msg.text}
								</pre>
							</div>
							{entryNotes.map((note) => (
								<HarvestNoteCard
									key={`note-${note.at}-${note.when}`}
									note={note}
								/>
							))}
						</div>
					);
				}

				return null;
			})}

			{/* Inter-bot Messages, if any */}
			{botMessages && botMessages.length > 0 && (
				<div className="bot-messages-container">
					{botMessages.map((bm) => (
						<div
							key={`${bm.fromBotId}-${bm.toBotId}-${bm.when}`}
							className="inter-bot-card"
						>
							<div className="inter-bot-header">
								<span className="inter-bot-icon">🤖</span>
								<strong>{bm.fromBotId}</strong>
								<span>➔</span>
								<strong>{bm.toBotId}</strong>
								<span className="message-time">
									{new Date(bm.when).toLocaleTimeString()}
								</span>
							</div>
							<div className="inter-bot-body">
								<p>
									<strong>Prompt:</strong> {bm.text}
								</p>
								{bm.reply && (
									<p>
										<strong>Reply:</strong> {bm.reply}
									</p>
								)}
							</div>
						</div>
					))}
				</div>
			)}

			{/* Active Live Streaming Turn */}
			{isStreamingActive && (
				<div className="chat-message-row assistant streaming-turn">
					<div className="message-meta assistant">
						<span className="badge badge-emerald">Assistant</span>
						<span className="badge badge-cyan streaming-pulse">
							Streaming...
						</span>
					</div>
					<div className="message-bubble assistant">
						<div className="assistant-blocks-container">
							{streamingState.thinking && (
								<ThinkingAccordion
									thinking={streamingState.thinking}
									defaultOpen={true}
									title="🧠 Thinking / Reasoning (Live)"
								/>
							)}
							{streamingState.toolCalls.length > 0 && (
								<div className="tool-chips-row">
									{streamingState.toolCalls.map((tc) => (
										<ToolCallCard key={tc.toolCallId} toolCall={tc} />
									))}
								</div>
							)}
							{streamingState.text && (
								<div className="streaming-text">
									<RenderedMarkdown text={streamingState.text} />
									<span className="streaming-cursor">▍</span>
								</div>
							)}
							{!streamingState.text &&
								!streamingState.thinking &&
								streamingState.toolCalls.length === 0 && (
									<div className="streaming-loading-dots">
										<span>Thinking</span>
										<span className="dot-pulse">...</span>
									</div>
								)}
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
