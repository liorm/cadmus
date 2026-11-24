import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { IdentityDrawer } from "@/components/chrome/IdentityDrawer";
import { useSession } from "@/context/SessionContext";
import { normalizePersonaRole } from "@/lib/persona-routing";
import { cn } from "@/lib/utils";

function initialsFrom(text: string): string {
	const cleaned = text.trim();
	if (!cleaned) return "?";
	const parts = cleaned.split(/[\s.@_-]+/).filter(Boolean);
	if (parts.length >= 2) {
		return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
	}
	return cleaned.slice(0, 2).toUpperCase();
}

/**
 * Compact user chip (`initials + name + (role · account)`) rendered in the
 * persona chrome bar; clicking opens the shared `IdentityDrawer`.
 */
export function IdentityChip({
	compact = false,
	className,
}: {
	compact?: boolean;
	className?: string;
}) {
	const { principal, memberships } = useSession();
	const [open, setOpen] = useState(false);

	const label =
		principal?.name?.trim() ||
		principal?.email?.trim() ||
		principal?.userId ||
		"Account";
	const role = normalizePersonaRole(principal?.role);
	const accountName =
		memberships.find((m) => m.accountId === principal?.accountId)?.name ||
		principal?.accountId ||
		"workspace";
	const initials = initialsFrom(label);

	return (
		<>
			<button
				type="button"
				onClick={() => setOpen(true)}
				aria-label="Open identity and account drawer"
				className={cn(
					"flex min-h-tap min-w-0 items-center gap-2 rounded-lg border border-border bg-surface px-2 py-1 text-left transition hover:bg-surface-raised",
					compact ? "justify-center px-1.5" : "w-full md:w-auto",
					className,
				)}
			>
				<span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/20 text-xs font-semibold text-accent">
					{initials}
				</span>
				{!compact ? (
					<>
						<span className="min-w-0 flex-1">
							<span className="block truncate text-xs font-semibold text-text">
								{label}
							</span>
							<span className="block truncate text-[11px] text-text-muted">
								{role} · {accountName}
							</span>
						</span>
						<ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-muted" />
					</>
				) : null}
			</button>
			<IdentityDrawer open={open} onClose={() => setOpen(false)} />
		</>
	);
}
