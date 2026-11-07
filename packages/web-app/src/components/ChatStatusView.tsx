import type {
	ChatStatusRecord,
	UsageBucket,
	UsageSummary,
} from "@cadmus/contract/types";
import { useState } from "react";

export function formatTokens(tokens: number): string {
	if (tokens <= 0) return "0 tok";
	if (tokens < 1000) return `${tokens} tok`;
	if (tokens < 1_000_000) {
		const val = (tokens / 1000).toFixed(1).replace(/\.0$/, "");
		return `${val}k tok`;
	}
	const val = (tokens / 1_000_000).toFixed(2).replace(/\.00$/, "");
	return `${val}M tok`;
}

export function formatCost(cost: number): string {
	if (cost <= 0) return "$0.00";
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	return `$${cost.toFixed(2)}`;
}

export function toolsEnvLine(env: ChatStatusRecord["toolsEnv"]): string {
	if (!env?.enabled) return "Off";
	const parts = [env.kind, env.envId, env.status].filter(
		(part): part is string => Boolean(part),
	);
	return parts.length > 0 ? parts.join(" · ") : "On";
}

export function nextWakeLine(at: number | null | undefined): string {
	if (at == null) return "None";
	return new Date(at).toLocaleString();
}

export function TokenCostGrid({ bucket }: { bucket: UsageBucket }) {
	return (
		<div className="grid grid-cols-2 gap-2 text-[length:var(--fs-xs)] sm:grid-cols-4">
			<div className="rounded border border-border-subtle bg-bg-subtle p-2">
				<span className="text-text-muted block">Input</span>
				<span className="font-mono font-medium">
					{formatTokens(bucket.input)}
				</span>
				<span className="text-text-muted block">
					{formatCost(bucket.cost.input)}
				</span>
			</div>
			<div className="rounded border border-border-subtle bg-bg-subtle p-2">
				<span className="text-text-muted block">Output</span>
				<span className="font-mono font-medium">
					{formatTokens(bucket.output)}
				</span>
				<span className="text-text-muted block">
					{formatCost(bucket.cost.output)}
				</span>
				{bucket.reasoning ? (
					<span className="text-text-muted block text-[10px]">
						(reasoning: {formatTokens(bucket.reasoning)})
					</span>
				) : null}
			</div>
			<div className="rounded border border-border-subtle bg-bg-subtle p-2">
				<span className="text-text-muted block">Cache Read</span>
				<span className="font-mono font-medium">
					{formatTokens(bucket.cacheRead)}
				</span>
				<span className="text-text-muted block">
					{formatCost(bucket.cost.cacheRead)}
				</span>
			</div>
			<div className="rounded border border-border-subtle bg-bg-subtle p-2">
				<span className="text-text-muted block">Cache Write</span>
				<span className="font-mono font-medium">
					{formatTokens(bucket.cacheWrite)}
				</span>
				<span className="text-text-muted block">
					{formatCost(bucket.cost.cacheWrite)}
				</span>
			</div>
		</div>
	);
}

export function SourcesList({ sources }: { sources: UsageSummary["sources"] }) {
	const sourceEntries: { key: keyof typeof sources; label: string }[] = [
		{ key: "direct", label: "Direct turns" },
		{ key: "harvest", label: "Idle harvest" },
		{ key: "schedules", label: "Schedules" },
		{ key: "botMessages", label: "Inter-bot messages" },
		{ key: "search", label: "Bot search" },
	];

	return (
		<div className="flex flex-col gap-1.5 text-[length:var(--fs-xs)]">
			{sourceEntries.map(({ key, label }) => {
				const b = sources[key];
				const hasUsage = b && b.totalTokens > 0;
				return (
					<div
						key={key}
						className="flex items-center justify-between py-1 border-b border-border-subtle last:border-0"
					>
						<span className={hasUsage ? "font-medium" : "text-text-muted"}>
							{label}
						</span>
						<span className="font-mono text-text-muted">
							{formatTokens(b?.totalTokens ?? 0)} ·{" "}
							{formatCost(b?.cost.total ?? 0)}
						</span>
					</div>
				);
			})}
		</div>
	);
}

export function ModelsList({ models }: { models: UsageSummary["models"] }) {
	const entries = Object.entries(models);
	if (entries.length === 0) return null;

	return (
		<div className="flex flex-col gap-1.5 text-[length:var(--fs-xs)]">
			{entries.map(([modelId, bucket]) => (
				<div
					key={modelId}
					className="flex items-center justify-between py-1 border-b border-border-subtle last:border-0"
				>
					<span className="truncate max-w-[200px] font-mono font-medium">
						{modelId}
					</span>
					<span className="font-mono text-text-muted">
						{formatTokens(bucket.totalTokens)} · {formatCost(bucket.cost.total)}
					</span>
				</div>
			))}
		</div>
	);
}

export function ChatStatusView({
	status,
	busy,
	model,
}: {
	status?: ChatStatusRecord;
	busy: boolean;
	model?: string;
}) {
	const [activeTab, setActiveTab] = useState<"chat" | "bot">("chat");
	const modelId = status?.model ?? model;
	const label = busy ? "Working…" : "Idle";

	const thinking = status?.thinking ?? "—";
	const openTasks = status?.tasks?.open ?? 0;
	const doneTasks = status?.tasks?.done ?? 0;
	const loopRound = status?.tasks?.loopRound;

	const activeUsage: UsageSummary | undefined =
		activeTab === "chat" ? status?.usage : status?.botUsage;

	return (
		<div data-testid="status-sheet" className="flex flex-col gap-4">
			<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-[length:var(--fs-sm)]">
				<dt className="text-text-muted">State</dt>
				<dd>{label}</dd>
				<dt className="text-text-muted">Model</dt>
				<dd className="truncate">{modelId ?? "—"}</dd>
				<dt className="text-text-muted">Thinking</dt>
				<dd>{thinking}</dd>
				<dt className="text-text-muted">Tasks</dt>
				<dd>
					{openTasks} open / {doneTasks} done
					{loopRound != null ? ` · loop ${loopRound}` : ""}
				</dd>
				<dt className="text-text-muted">Next wake</dt>
				<dd>{nextWakeLine(status?.nextWakeAt)}</dd>
				<dt className="text-text-muted">Tools env</dt>
				<dd className="truncate">{toolsEnvLine(status?.toolsEnv)}</dd>
			</dl>

			<div className="flex flex-col gap-3 border-t border-border-subtle pt-3">
				<div className="flex items-center justify-between">
					<span className="font-medium text-[length:var(--fs-sm)]">
						Token Spend & Cost
					</span>
					<div
						role="tablist"
						className="flex rounded-md border border-border-subtle bg-bg-subtle p-0.5 text-[length:var(--fs-xs)]"
					>
						<button
							type="button"
							role="tab"
							aria-selected={activeTab === "chat"}
							data-testid="status-tab-chat"
							onClick={() => setActiveTab("chat")}
							className={`rounded px-2.5 py-1 font-medium transition-colors ${
								activeTab === "chat"
									? "bg-surface-elevated text-text-primary shadow-sm"
									: "text-text-muted hover:text-text-primary"
							}`}
						>
							This chat
						</button>
						<button
							type="button"
							role="tab"
							aria-selected={activeTab === "bot"}
							data-testid="status-tab-bot"
							onClick={() => setActiveTab("bot")}
							className={`rounded px-2.5 py-1 font-medium transition-colors ${
								activeTab === "bot"
									? "bg-surface-elevated text-text-primary shadow-sm"
									: "text-text-muted hover:text-text-primary"
							}`}
						>
							Bot total
						</button>
					</div>
				</div>

				<div className="flex items-baseline justify-between rounded bg-bg-subtle p-3">
					<span className="text-[length:var(--fs-xs)] text-text-muted">
						Total estimated spend
					</span>
					<div className="text-right">
						<span className="font-mono text-[length:var(--fs-base)] font-semibold">
							{formatCost(activeUsage?.totals?.cost?.total ?? 0)}
						</span>
						<span className="block text-[11px] text-text-muted font-mono">
							{formatTokens(activeUsage?.totals?.totalTokens ?? 0)}
						</span>
					</div>
				</div>

				{activeUsage?.totals ? (
					<TokenCostGrid bucket={activeUsage.totals} />
				) : null}

				{activeUsage?.sources ? (
					<div className="flex flex-col gap-1.5 border-t border-border-subtle pt-3">
						<span className="text-[length:var(--fs-xs)] font-medium text-text-muted uppercase tracking-wider">
							By Source
						</span>
						<SourcesList sources={activeUsage.sources} />
					</div>
				) : null}

				{activeUsage?.models && Object.keys(activeUsage.models).length > 0 ? (
					<div className="flex flex-col gap-1.5 border-t border-border-subtle pt-3">
						<span className="text-[length:var(--fs-xs)] font-medium text-text-muted uppercase tracking-wider">
							By Model
						</span>
						<ModelsList models={activeUsage.models} />
					</div>
				) : null}
			</div>
		</div>
	);
}
