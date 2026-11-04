import { cn } from "@/lib/utils";

export function UnreadDot({ className }: { className?: string }) {
	return (
		<span
			role="status"
			aria-label="Unread"
			className={cn("inline-block size-2 rounded-full bg-unread", className)}
		/>
	);
}
