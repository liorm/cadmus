import type { ReactNode } from "react";
import { StatusShape } from "@/components/StatusShape";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function LiveCard({
	title = "Working",
	collapsed = false,
	onToggle,
	children,
	className,
	progress,
	onSteer,
	onStop,
}: {
	title?: string;
	collapsed?: boolean;
	onToggle?: () => void;
	children?: ReactNode;
	className?: string;
	progress?: number;
	onSteer?: () => void;
	onStop?: () => void;
}) {
	const ratio =
		progress === undefined ? undefined : Math.min(1, Math.max(0, progress));
	return (
		<section
			aria-label="Live card"
			className={cn(
				"rounded-md border border-status-running/40 bg-surface-raised p-3",
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
			{collapsed ? null : (
				<div className="mt-2 text-[length:var(--fs-sm)] text-text-muted">
					{children}
				</div>
			)}
			<div
				className="mt-2 h-1 overflow-hidden rounded-full bg-border"
				role="progressbar"
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={
					ratio === undefined ? undefined : Math.round(ratio * 100)
				}
			>
				<div
					className={cn(
						"h-full bg-status-running",
						ratio === undefined ? "w-1/3 cadmus-spin" : "",
					)}
					style={ratio === undefined ? undefined : { width: `${ratio * 100}%` }}
				/>
			</div>
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
