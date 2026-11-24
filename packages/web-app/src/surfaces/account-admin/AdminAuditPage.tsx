import type { AccountAuditListResult } from "@cadmus/contract/types";
import { Search } from "lucide-react";
import { useState } from "react";
import { LoadGate } from "@/components/Skeleton";
import { useCadmus } from "@/context/CadmusContext";
import { useScopedResource } from "@/hooks/useScopedResource";
import { isoTime } from "@/lib/session";
import { AccountAdminShell } from "@/surfaces/account-admin/AccountAdminShell";

type AuditEvent = AccountAuditListResult["events"][number];
const PAGE_SIZE = 50;

export function AdminAuditPage() {
	const { client } = useCadmus();
	const [filter, setFilter] = useState("");
	const [older, setOlder] = useState<AuditEvent[]>([]);
	const [loadingMore, setLoadingMore] = useState(false);
	const [exhausted, setExhausted] = useState(false);
	const [moreError, setMoreError] = useState<string | null>(null);

	const loaded = useScopedResource("admin-audit", async () => {
		const res = await client.callRpc<AccountAuditListResult>(
			"account.audit.list",
			{ limit: PAGE_SIZE },
		);
		if (!res.ok) {
			throw new Error(res.error?.message ?? "Could not load account audit log");
		}
		return res.result?.events ?? [];
	});

	const first = loaded.data ?? [];
	const seen = new Set(first.map((e) => e.id));
	const combined = [...first, ...older.filter((e) => !seen.has(e.id))];
	const q = filter.trim().toLowerCase();
	const filtered = combined.filter((ev) => {
		if (!q) return true;
		return (
			ev.action.toLowerCase().includes(q) ||
			(ev.actorUserId ?? "").toLowerCase().includes(q) ||
			(ev.target ?? "").toLowerCase().includes(q)
		);
	});

	const last = combined.at(-1);
	const canLoadMore =
		!exhausted && first.length >= PAGE_SIZE && last !== undefined;

	async function loadMore() {
		if (!last || loadingMore) return;
		setLoadingMore(true);
		setMoreError(null);
		const res = await client.callRpc<AccountAuditListResult>(
			"account.audit.list",
			{ limit: PAGE_SIZE, before: last.at, beforeId: last.id },
		);
		setLoadingMore(false);
		if (!res.ok) {
			setMoreError(res.error?.message ?? "Could not load older audit events.");
			return;
		}
		const page = res.result?.events ?? [];
		setOlder((prev) => [...prev, ...page]);
		if (page.length < PAGE_SIZE) setExhausted(true);
	}

	return (
		<AccountAdminShell activeTab="audit" title="Account Audit Log">
			<div className="space-y-4">
				<div className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2">
					<Search className="h-4 w-4 text-text-muted" />
					<input
						aria-label="Filter audit events"
						placeholder="Filter by action, actor user id, or target…"
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
						className="min-w-0 flex-1 bg-transparent text-xs text-text outline-none"
					/>
				</div>

				<LoadGate
					phase={loaded.phase}
					error={loaded.error}
					onRetry={loaded.retry}
					label="Loading audit log"
				>
					<div className="overflow-hidden rounded-xl border border-border bg-surface">
						{filtered.length === 0 ? (
							<p className="p-4 text-xs text-text-muted">
								No audit events recorded yet.
							</p>
						) : (
							<ul className="divide-y divide-border">
								{filtered.map((ev) => (
									<li key={ev.id} className="space-y-1 p-3.5 text-xs">
										<div className="flex flex-wrap items-center justify-between gap-2">
											<span className="font-mono font-semibold text-accent">
												{ev.action}
											</span>
											<span className="text-[11px] text-text-muted">
												{isoTime(ev.at)}
											</span>
										</div>
										<div className="text-[11px] text-text-muted">
											Actor: {ev.actorKind}
											{ev.actorUserId ? ` (${ev.actorUserId})` : ""}
											{ev.target ? ` · Target: ${ev.target}` : ""}
										</div>
										{ev.data !== undefined && ev.data !== null ? (
											<pre className="overflow-x-auto rounded bg-bg px-2 py-1 font-mono text-[10px] text-text-muted">
												{JSON.stringify(ev.data)}
											</pre>
										) : null}
									</li>
								))}
							</ul>
						)}
					</div>
					{moreError ? (
						<p role="alert" className="text-xs text-destructive">
							{moreError}
						</p>
					) : null}
					{canLoadMore ? (
						<button
							type="button"
							disabled={loadingMore}
							onClick={() => void loadMore()}
							className="min-h-tap rounded-lg border border-border px-4 text-xs font-medium text-text hover:bg-surface-raised disabled:opacity-50"
						>
							{loadingMore ? "Loading…" : "Load older events"}
						</button>
					) : null}
				</LoadGate>
			</div>
		</AccountAdminShell>
	);
}
