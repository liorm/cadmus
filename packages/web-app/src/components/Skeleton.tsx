import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { LoadPhase } from "@/lib/load-state";
import { cn } from "@/lib/utils";

export function Skeleton({ className }: { className?: string }) {
	return (
		<span aria-hidden="true" className={cn("cadmus-skeleton", className)} />
	);
}

export function SkeletonBlock({
	label,
	rows = 3,
}: {
	label: string;
	rows?: number;
}) {
	return (
		<div
			role="status"
			aria-busy="true"
			aria-label={label}
			className="flex flex-col gap-3 px-3 py-4"
		>
			{["one", "two", "three", "four"].slice(0, rows).map((key, index) => (
				<Skeleton
					key={key}
					className={index === rows - 1 ? "h-4 w-2/3" : "h-4 w-full"}
				/>
			))}
		</div>
	);
}

export function HintSkeleton() {
	return <Skeleton className="mt-1 block h-3 w-40 max-w-full" />;
}

export function LoadError({
	message,
	onRetry,
}: {
	message: string;
	onRetry: () => void;
}) {
	return (
		<div role="alert" className="flex flex-col items-start gap-3 px-3 py-4">
			<p className="text-[length:var(--fs-sm)] text-text">{message}</p>
			<Button type="button" variant="outlined" onClick={onRetry}>
				Retry
			</Button>
		</div>
	);
}

export function LoadGate({
	phase,
	error,
	onRetry,
	label,
	children,
}: {
	phase: LoadPhase;
	error?: string;
	onRetry: () => void;
	label: string;
	children: ReactNode;
}) {
	if (phase === "error") {
		return <LoadError message={error ?? "Could not load"} onRetry={onRetry} />;
	}
	if (phase === "loading") return <SkeletonBlock label={label} />;
	return children;
}
