import { formatRemaining, useElevation } from "@/context/ElevationContext";
import { useSession } from "@/context/SessionContext";
import { useMemberships } from "@/hooks/useMemberships";

const bar =
	"flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-status-needs-you/40 bg-status-needs-you/15 px-3 py-1.5 text-[length:var(--fs-sm)] font-medium text-status-needs-you";
const action = "min-h-tap rounded-md border border-current px-3 font-semibold";

/**
 * Shown on every screen while admin mode is on, so a sensitive session is
 * never invisible. Counts down and offers a way out. If an exit could not be
 * confirmed, it stays up and says the state is uncertain instead of
 * disappearing, with the error and a way to check again.
 */
export function AdminModeBanner() {
	const { until, now, busy, error, toggle, recheck, maybeOn } = useElevation();
	const session = useSession();
	const memberships = useMemberships();
	if (!maybeOn) return null;
	const accountId = session.principal?.accountId;
	const accountName =
		memberships.find((m) => m.accountId === accountId)?.name ?? accountId;
	const where =
		memberships.length > 1 && accountName ? ` in ${accountName}` : "";
	const known = typeof until === "number";
	return (
		<div role="status" aria-label="Admin mode" className={bar}>
			{known ? (
				<span>
					Admin mode on{where}, ends in {formatRemaining(until - now)}
				</span>
			) : until === "unknown" ? (
				<span>Checking admin mode...</span>
			) : (
				<span>Admin mode may still be on.</span>
			)}
			{error ? <span role="alert">{error}</span> : null}
			{known ? (
				<button
					type="button"
					disabled={busy}
					className={action}
					onClick={() => {
						void toggle(false);
					}}
				>
					Leave
				</button>
			) : until === "unreadable" ? (
				<button type="button" className={action} onClick={recheck}>
					Check again
				</button>
			) : null}
		</div>
	);
}
