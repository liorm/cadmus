import type {
	ChatStatusRecord,
	UsageBucket,
	UsageSummary,
} from "@cadmus/contract/types";
import { useState } from "react";
import { BottomSheet } from "@/components/BottomSheet";
import { StatusShape } from "@/components/StatusShape";

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

function toolsEnvLine(env: ChatStatusRecord["toolsEnv"]): string {
	if (!env?.enabled) return "Off";
	const parts = [env.kind, env.envId, env.status].filter(
		(part): part is string => Boolean(part),
	);
	return parts.length > 0 ? parts.join(" · ") : "On";
}

function nextWakeLine(at: number | null | undefined): string {
	if (at == null) return "None";
	return new Date(at).toLocaleString();
}

function TokenCostGrid({ bucket }: { bucket: UsageBucket }) {
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

function SourcesList({ sources }: { sources: UsageSummary["sources"] }) {
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

function ModelsList({ models }: { models: UsageSummary["models"] }) {
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

export function ChatStatusIndicator({
	status,
	busy,
	model,
	onOpen,
}: {
	status?: ChatStatusRecord;
	busy: boolean;
	model?: string;
	onOpen?: () => Promise<void> | void;
}) {
	const [open, setOpen] = useState(false);
	const [activeTab, setActiveTab] = useState<"chat" | "bot">("chat");
	const modelId = status?.model ?? model;
	const label = busy ? "Working…" : "Idle";

	const totalTokens = status?.usage?.totals?.totalTokens ?? 0;
	const totalCost = status?.usage?.totals?.cost?.total ?? 0;
	const tokenSnippet =
		totalTokens > 0
			? ` · ${formatTokens(totalTokens)} · ${formatCost(totalCost)}`
			: "";
	const compact = modelId
		? `${label} · ${modelId}${tokenSnippet}`
		: `${label}${tokenSnippet}`;

	const thinking = status?.thinking ?? "—";
	const openTasks = status?.tasks?.open ?? 0;
	const doneTasks = status?.tasks?.done ?? 0;
	const loopRound = status?.tasks?.loopRound;

	const activeUsage: UsageSummary | undefined =
		activeTab === "chat" ? status?.usage : status?.botUsage;

	const handleOpen = () => {
		setOpen(true);
		void onOpen?.();
	};

	return (
		<>
			<button
				type="button"
				aria-label="Bot status"
				data-testid="status-indicator-button"
				onClick={handleOpen}
				className="inline-flex min-h-0 max-w-full items-center gap-1 truncate text-left text-[length:var(--fs-sm)] text-text-muted hover:text-text-primary"
			>
				{busy ? <StatusShape status="running" /> : null}
				<span className="truncate">{compact}</span>
			</button>
			<BottomSheet
				open={open}
				onOpenChange={setOpen}
				title="Bot status"
				cancelLabel="Close"
			>
				<div data-testid="status-sheet" className="flex flex-col gap-4 px-1">
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

						{activeUsage ? (
							<div className="flex flex-col gap-3">
								<div className="flex items-baseline justify-between rounded-md border border-border-subtle bg-bg-subtle px-3 py-2">
									<span className="text-text-muted text-[length:var(--fs-xs)]">
										Total estimated spend
									</span>
									<span className="font-mono font-semibold text-[length:var(--fs-md)]">
										{formatTokens(activeUsage.totals.totalTokens)} ·{" "}
										{formatCost(activeUsage.totals.cost.total)}
									</span>
								</div>

								<div className="flex flex-col gap-1.5">
									<span className="text-text-muted text-[length:var(--fs-xs)] font-medium">
										Breakdown
									</span>
									<TokenCostGrid bucket={activeUsage.totals} />
								</div>

								<div className="flex flex-col gap-1.5">
									<span className="text-text-muted text-[length:var(--fs-xs)] font-medium">
										By Source
									</span>
									<SourcesList sources={activeUsage.sources} />
								</div>

								{Object.keys(activeUsage.models).length > 0 ? (
									<div className="flex flex-col gap-1.5">
										<span className="text-text-muted text-[length:var(--fs-xs)] font-medium">
											By Model
										</span>
										<ModelsList models={activeUsage.models} />
									</div>
								) : null}
							</div>
						) : (
							<p className="text-text-muted text-[length:var(--fs-xs)] italic">
								No usage recorded yet.
							</p>
						)}
					</div>
				</div>
			</BottomSheet>
		</>
	);
}
