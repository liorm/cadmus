import type { BotRecord } from "@cadmus/contract/types";
import { useState } from "react";
import { BotBadge } from "@/components/BotBadge";
import { Button } from "@/components/ui/button";
import {
	type GroupChatMessage,
	parseMessageBotArgs,
	parseMessageBotResult,
} from "@/lib/group-chat-data";
import type { ToolExecutionDetail } from "@/lib/group-tool-runs";
import { cn } from "@/lib/utils";

export interface ToolCallCardProps {
	call: ToolExecutionDetail;
	bots?: BotRecord[];
	compact?: boolean;
	onOpenGroupChat?: (data: {
		topic?: string;
		status?: string;
		members?: string[];
		transcript?: GroupChatMessage[];
		response?: string;
		groupId?: string;
	}) => void;
}

function formatDuration(ms?: number): string | null {
	if (ms === undefined || ms === null) return null;
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

function safeStringify(val: unknown): string {
	if (typeof val === "string") return val;
	try {
		return JSON.stringify(val, null, 2);
	} catch {
		return String(val);
	}
}

export function ToolCallCard({
	call,
	bots = [],
	compact = false,
	onOpenGroupChat,
}: ToolCallCardProps) {
	const [expanded, setExpanded] = useState(false);
	const duration = formatDuration(call.durationMs);
	const isError = Boolean(call.isError || call.result?.isError);

	const botMap = new Map<string, BotRecord>();
	for (const b of bots) {
		botMap.set(b.id, b);
	}

	const isMessageBot = call.name === "message_bot";
	const mbArgs = isMessageBot ? parseMessageBotArgs(call.args) : null;
	const mbResult = isMessageBot
		? parseMessageBotResult(call.result?.content)
		: null;

	const targetSlug = mbArgs?.slug ?? mbArgs?.to?.[0];
	const targetBot = targetSlug ? botMap.get(targetSlug) : undefined;
	const topic = mbArgs?.topic ?? mbResult?.topic;
	const msgCount = mbResult?.transcript?.length ?? 0;

	return (
		<div
			data-testid={`tool-card-${call.name}`}
			className={cn(
				compact
					? "border-b border-border/40 text-text last:border-b-0"
					: "rounded-md border border-border bg-surface text-text",
				isError &&
					(compact ? "text-status-failed" : "border-status-failed/40"),
			)}
		>
			<button
				type="button"
				aria-expanded={expanded}
				aria-label={`Toggle details for ${call.name}`}
				onClick={() => setExpanded((v) => !v)}
				className={cn(
					"flex w-full items-center gap-2 text-left transition hover:bg-surface-raised/60",
					compact
						? "px-2 py-1 text-xs"
						: "min-h-tap px-3 py-1.5 text-[length:var(--fs-sm)]",
				)}
			>
				<span
					className={cn(
						"text-xs font-bold",
						isError ? "text-status-failed" : "text-status-success",
					)}
					aria-hidden="true"
				>
					{isError ? "✕" : "✓"}
				</span>

				<span className="font-mono text-[length:var(--fs-xs)] font-medium text-text">
					{call.name}
				</span>

				{isMessageBot && topic ? (
					<span className="min-w-0 flex-1 truncate text-[length:var(--fs-xs)] text-text-muted">
						· {topic}
					</span>
				) : (
					<span className="flex-1" />
				)}

				{duration ? (
					<span className="text-[length:var(--fs-xs)] text-text-muted">
						{duration}
					</span>
				) : null}

				<span
					aria-hidden="true"
					className={cn(
						"inline-flex items-center justify-center text-text-muted",
						compact ? "px-1 py-0.5" : "min-h-tap min-w-tap",
					)}
				>
					{expanded ? "▾" : "›"}
				</span>
			</button>

			{isMessageBot ? (
				<div className="border-t border-border/60 bg-surface-raised/40 px-3 py-2">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<div className="flex items-center gap-2">
							{targetBot || targetSlug ? (
								<span className="inline-flex items-center gap-1.5 text-[length:var(--fs-xs)] text-text-muted">
									To:
									<BotBadge
										bot={
											targetBot ?? {
												id: targetSlug ?? "bot",
												name: targetSlug ?? "bot",
											}
										}
										className="size-4 min-h-0 min-w-0 text-[10px]"
									/>
									<span className="font-medium text-text">
										{targetBot?.name ?? targetSlug}
									</span>
								</span>
							) : null}
							{mbResult?.status ? (
								<span
									className={cn(
										"rounded px-1.5 py-0.5 text-[10px] font-medium",
										mbResult.status === "ended"
											? "bg-status-success/15 text-status-success"
											: "bg-surface text-text-muted",
									)}
								>
									{mbResult.status}
								</span>
							) : null}
						</div>

						{onOpenGroupChat ? (
							<Button
								type="button"
								variant="outlined"
								className="min-h-0 min-w-0 h-7 px-2.5 text-[length:var(--fs-xs)]"
								onClick={() => {
									onOpenGroupChat({
										topic: topic ?? "Inter-bot Chat",
										status: mbResult?.status ?? "ended",
										members:
											mbResult?.members ?? (targetSlug ? [targetSlug] : []),
										transcript: mbResult?.transcript,
										response: mbResult?.response,
										groupId: mbResult?.groupId,
									});
								}}
							>
								View Group Chat {msgCount > 0 ? `(${msgCount})` : ""} ›
							</Button>
						) : null}
					</div>
				</div>
			) : null}

			{expanded ? (
				<div className="border-t border-border px-3 py-2 text-[length:var(--fs-xs)]">
					{call.args ? (
						<div className="mb-2">
							<div className="mb-1 font-semibold text-text-muted">
								Arguments:
							</div>
							<pre className="max-h-36 overflow-auto rounded bg-bg p-2 font-mono text-[11px] text-text whitespace-pre-wrap">
								{safeStringify(call.args)}
							</pre>
						</div>
					) : null}

					{call.result?.content ? (
						<div>
							<div className="mb-1 font-semibold text-text-muted">Result:</div>
							<pre
								className={cn(
									"max-h-48 overflow-auto rounded bg-bg p-2 font-mono text-[11px] text-text whitespace-pre-wrap",
									isError &&
										"border border-status-failed/40 text-status-failed",
								)}
							>
								{safeStringify(call.result.content)}
							</pre>
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}
