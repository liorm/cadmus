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

/**
 * The server refuses a command the caller's sign-in is not allowed to run
 * with a plain message (a missing role grant, or an API token on a user-only
 * command). That message is matched here only to pick a clearer screen: a
 * refusal will not change on retry, so there is no Retry. Any other message,
 * including a reworded refusal, still gets the raw text and Retry.
 */
const REFUSAL = /does not hold grant|^API tokens cannot/;

export function isRefusalMessage(message: string): boolean {
	return REFUSAL.test(message);
}

export function LoadError({
	message,
	onRetry,
}: {
	message: string;
	onRetry: () => void;
}) {
	if (isRefusalMessage(message)) {
		return (
			<div role="alert" className="flex flex-col items-start gap-2 px-3 py-4">
				<p className="text-[length:var(--fs-sm)] font-semibold text-text">
					Not available for this sign-in
				</p>
				<p className="text-[length:var(--fs-sm)] text-text-muted">
					The server did not allow this for your current role or token. Sign in
					as a user with access, or ask an account admin.
				</p>
				<p className="break-words text-[length:var(--fs-xs)] text-text-muted">
					Server said: {message}
				</p>
			</div>
		);
	}
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
