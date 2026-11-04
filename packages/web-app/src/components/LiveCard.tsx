import type { ReactNode } from "react";
import { StatusShape } from "@/components/StatusShape";
import { cn } from "@/lib/utils";

export function LiveCard({
	title = "Live",
	collapsed = false,
	onToggle,
	children,
	className,
}: {
	title?: string;
	collapsed?: boolean;
	onToggle?: () => void;
	children?: ReactNode;
	className?: string;
}) {
	return (
		<section
			aria-label="Live card"
			className={cn(
				"rounded-md border border-border bg-surface-raised p-3",
				className,
			)}
		>
			<header className="flex min-h-tap items-center gap-2">
				<StatusShape status="running" />
				<h2 className="flex-1 text-[length:var(--fs-md)] font-medium">
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
		</section>
	);
}
