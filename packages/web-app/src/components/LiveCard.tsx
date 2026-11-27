import type { ReactNode } from "react";
import { StatusShape } from "@/components/StatusShape";
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
				"rounded-lg border border-border bg-surface/60 px-3 py-2",
				frozen && "pointer-events-none opacity-50",
				className,
			)}
		>
			<header className="flex min-h-7 items-center gap-2">
				<StatusShape status="running" />
				<h2 className="flex-1 text-xs font-medium text-text-muted">{title}</h2>
				<div className="flex shrink-0 items-center gap-1.5">
					{onSteer ? (
						<button
							type="button"
							aria-label="Steer live"
							onClick={onSteer}
							className="inline-flex h-7 items-center rounded-md border border-border px-2 text-xs font-medium text-text-muted hover:bg-surface-raised hover:text-text"
						>
							↪ Steer
						</button>
					) : null}
					{onStop ? (
						<button
							type="button"
							aria-label="Stop"
							onClick={onStop}
							className="inline-flex h-7 items-center rounded-md border border-status-failed/40 px-2 text-xs font-medium text-status-failed hover:bg-status-failed/10"
						>
							Stop
						</button>
					) : null}
					{onToggle ? (
						<button
							type="button"
							aria-expanded={!collapsed}
							aria-label={collapsed ? "Expand live card" : "Collapse live card"}
							onClick={onToggle}
							className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-surface-raised hover:text-text"
						>
							{collapsed ? "▾" : "▴"}
						</button>
					) : null}
				</div>
			</header>
			{activeBanner ? <div className="mt-2">{activeBanner}</div> : null}
			{!collapsed && children ? (
				<div className="mt-2 max-w-[70ch] text-[15px] leading-relaxed text-text">
					{children}
				</div>
			) : null}
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
		</section>
	);
}
