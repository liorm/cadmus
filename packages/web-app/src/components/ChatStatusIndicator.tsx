import type { BotRecord, ChatStatusRecord } from "@cadmus/contract/types";
import { useNavigate } from "@tanstack/react-router";
import { BotPill } from "@/components/BotChip";
import { formatCost, formatTokens } from "@/components/ChatStatusView";
import { StatusShape } from "@/components/StatusShape";

export { formatCost, formatTokens };

export function ChatStatusIndicator({
	chatKey,
	bot,
	status,
	busy,
	model,
	archived,
	failed,
}: {
	chatKey: string;
	bot?: Pick<BotRecord, "id" | "name" | "metadata">;
	status?: ChatStatusRecord;
	busy: boolean;
	model?: string;
	archived?: boolean;
	failed?: boolean;
}) {
	const navigate = useNavigate();
	const modelId = status?.model ?? model;
	const label = busy ? "Working…" : "Idle";

	const totalTokens = status?.usage?.totals?.totalTokens ?? 0;
	const totalCost = status?.usage?.totals?.cost?.total ?? 0;

	const handleOpen = () => {
		void navigate({
			to: "/chat/$chatKey/status",
			params: { chatKey },
		});
	};

	return (
		<button
			type="button"
			aria-label="Bot status"
			data-testid="status-indicator-button"
			onClick={handleOpen}
			className="flex min-w-0 flex-col items-start gap-0.5 text-left text-text-muted hover:text-text-primary"
		>
			<div className="flex min-w-0 max-w-full items-center gap-1.5 truncate text-[length:var(--fs-xs)]">
				{bot ? <BotPill bot={bot} /> : null}
				{archived ? <span>Archived</span> : null}
				{failed ? <StatusShape status="failed" /> : null}
				{busy ? <StatusShape status="running" /> : null}
				<span className="truncate">
					{label}
					{modelId ? ` · ${modelId}` : ""}
				</span>
			</div>
			{archived ? null : (
				<div className="truncate font-mono text-[11px] text-text-muted">
					{totalTokens > 0
						? `${formatTokens(totalTokens)} · ${formatCost(totalCost)}`
						: "0 tok · $0.00"}
				</div>
			)}
		</button>
	);
}
