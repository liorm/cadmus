import { cn } from "@/lib/utils";

export type StatusKind = "running" | "needs-you" | "failed" | "none";

export function StatusShape({
	status,
	className,
}: {
	status: StatusKind;
	className?: string;
}) {
	if (status === "none") {
		return (
			<span
				aria-hidden="true"
				className={cn("inline-block size-4", className)}
			/>
		);
	}
	if (status === "running") {
		return (
			<span
				role="status"
				aria-label="Running"
				className={cn(
					"cadmus-spin inline-block size-4 rounded-full border-2 border-status-running border-t-transparent",
					className,
				)}
			/>
		);
	}
	if (status === "needs-you") {
		return (
			<span
				role="status"
				aria-label="Needs you"
				className={cn(
					"inline-flex size-4 items-center justify-center rounded-full bg-status-needs-you text-[10px] font-bold text-on-accent",
					className,
				)}
			>
				!
			</span>
		);
	}
	return (
		<span
			role="status"
			aria-label="Failed"
			className={cn(
				"inline-flex size-4 items-center justify-center rounded-full bg-status-failed text-[10px] font-bold text-on-accent",
				className,
			)}
		>
			✕
		</span>
	);
}
