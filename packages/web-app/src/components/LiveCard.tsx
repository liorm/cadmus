import type { ReactNode } from "react";
import { StatusShape } from "@/components/StatusShape";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function LiveCard({
	title = "Working",
	collapsed = false,
	onToggle,
	children,
	activeBanner,
	className,
	progress,
	onSteer,
	onStop,
	frozen = false,
}: {
	title?: string;
	collapsed?: boolean;
	onToggle?: () => void;
	children?: ReactNode;
	activeBanner?: ReactNode;
	className?: string;
	progress?: number;
	onSteer?: () => void;
	onStop?: () => void;
	frozen?: boolean;
}) {
	const ratio =
		progress === undefined ? undefined : Math.min(1, Math.max(0, progress));
	return (
		<section
			aria-label="Live card"
			aria-disabled={frozen || undefined}
			className={cn(
				"rounded-md border border-status-running/40 bg-surface-raised p-3",
				frozen && "pointer-events-none opacity-50",
				className,
			)}
		>
			<header className="flex min-h-tap items-center gap-2">
				<StatusShape status="running" />
				<h2 className="flex-1 text-[length:var(--fs-md)] font-medium text-status-running">
					{title}
				</h2>
				{onToggle ? (
					<button
						type="button"
						aria-expanded={!collapsed}
						aria-label={collapsed ? "Expand live card" : "Collapse live card"}
						onClick={onToggle}
						className="inline-flex min-h-tap min-w-tap items-center justify-center"
					>
						{collapsed ? "▾" : "▴"}
					</button>
				) : null}
			</header>
			{activeBanner ? <div className="mt-2">{activeBanner}</div> : null}
			{collapsed ? null : (
				<div className="mt-2 text-[length:var(--fs-sm)] text-text-muted">
					{children}
				</div>
			)}
			{ratio !== undefined ? (
				<div
					className="mt-2 h-1 overflow-hidden rounded-full bg-border"
					role="progressbar"
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={Math.round(ratio * 100)}
				>
					<div
						className="h-full bg-status-running transition-[width] duration-300 ease-out"
						style={{ width: `${ratio * 100}%` }}
					/>
				</div>
			) : null}
			<div className="mt-2 flex gap-2">
				<Button
					variant="ghost"
					className="flex-1 border border-border bg-bg"
					aria-label="Steer live"
					onClick={onSteer}
				>
					↪ Steer
				</Button>
				<Button
					variant="danger"
					className="flex-1"
					aria-label="Stop"
					onClick={onStop}
				>
					■ Stop
				</Button>
			</div>
		</section>
	);
}
