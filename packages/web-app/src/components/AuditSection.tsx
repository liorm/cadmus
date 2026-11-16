import type { AccountAuditListResult } from "@cadmus/contract/types";
import { useState } from "react";
import { isRefusalMessage, LoadGate } from "@/components/Skeleton";
import { useCadmus } from "@/context/CadmusContext";
import { useScopedResource } from "@/hooks/useScopedResource";
import { isoTime } from "@/lib/session";

type AuditEvent = AccountAuditListResult["events"][number];

const PAGE = 50;

const buttonClass =
	"min-h-tap rounded-md border border-border px-3 disabled:opacity-50";

/** Event details as plain text: the shape depends on the action. */
function detailText(data: unknown): string {
	if (data === undefined || data === null) return "";
	try {
		return JSON.stringify(data);
	} catch {
		return "";
	}
}

/**
 * The account's recorded audit events, newest first, read only. It lists what
 * the server recorded for this account, not proof that every change was
 * recorded. The worker decides who may read it.
 */
export function AuditSection() {
	const { client } = useCadmus();
	const [older, setOlder] = useState<AuditEvent[]>([]);
	const [more, setMore] = useState<{
		busy: boolean;
		error: string | null;
		done: boolean;
	}>({ busy: false, error: null, done: false });
	const loaded = useScopedResource("audit", async () => {
		const res = await client.callRpc<AccountAuditListResult>(
			"account.audit.list",
			{ limit: PAGE },
		);
		if (!res.ok) {
			throw new Error(res.error?.message ?? "Could not load the audit log");
		}
		return res.result?.events ?? [];
	});
	const first = loaded.data ?? [];
	const seen = new Set(first.map((e) => e.id));
	const events = [...first, ...older.filter((e) => !seen.has(e.id))];
	const last = events.at(-1);
	const canLoadMore = !more.done && first.length >= PAGE && last !== undefined;

	const loadOlder = () => {
		if (!last || more.busy) return;
		setMore({ busy: true, error: null, done: false });
		void client
			.callRpc<AccountAuditListResult>("account.audit.list", {
				limit: PAGE,
				before: last.at,
				beforeId: last.id,
			})
			.then((res) => {
				if (!res.ok) {
					setMore({
						busy: false,
						error: res.error?.message ?? "Could not load older events",
						done: false,
					});
					return;
				}
				const page = res.result?.events ?? [];
				setOlder((prev) => [...prev, ...page]);
				setMore({ busy: false, error: null, done: page.length < PAGE });
			})
			.catch((err: unknown) =>
				setMore({
					busy: false,
					error: err instanceof Error ? err.message : "Network error",
					done: false,
				}),
			);
	};

	return (
		<section aria-label="Audit log" className="flex flex-col gap-2">
			<h2 className="text-[length:var(--fs-xs)] font-semibold uppercase tracking-wide text-text-muted">
				Audit log
			</h2>
			<p className="text-[length:var(--fs-sm)] text-text-muted">
				Events recorded for this account, newest first. It is a list of what was
				recorded, not a guarantee that every change appears.
			</p>
			{loaded.phase === "error" && isRefusalMessage(loaded.error ?? "") ? (
				<p role="alert" className="break-words text-text-muted">
					The server did not allow reading the audit log ({loaded.error}).
				</p>
			) : (
				<LoadGate
					phase={loaded.phase}
					error={loaded.error}
					onRetry={loaded.retry}
					label="Loading the audit log"
				>
					{events.length === 0 ? (
						<p className="px-3 py-3 text-text-muted">No events recorded.</p>
					) : (
						<ul className="overflow-hidden rounded-md border border-border bg-surface">
							{events.map((event) => {
								const details = detailText(event.data);
								return (
									<li
										key={event.id}
										className="flex flex-col gap-1 border-b border-border px-3 py-2 last:border-b-0"
									>
										<div className="flex flex-wrap items-baseline justify-between gap-x-3">
											<span className="break-all font-semibold">
												{event.action}
											</span>
											<time className="text-[length:var(--fs-xs)] text-text-muted">
												{isoTime(event.at)}
											</time>
										</div>
										<div className="break-all text-[length:var(--fs-sm)] text-text-muted">
											{event.actorKind === "user"
												? (event.actorUserId ?? "unknown user")
												: `${event.actorKind}${event.actorUserId ? ` ${event.actorUserId}` : ""}`}
											{event.target ? ` → ${event.target}` : ""}
										</div>
										{details ? (
											<div className="break-all font-mono text-[length:var(--fs-xs)] text-text-muted">
												{details}
											</div>
										) : null}
									</li>
								);
							})}
						</ul>
					)}
					{more.error ? (
						<p role="alert" className="text-destructive">
							Older events could not be loaded ({more.error}).
						</p>
					) : null}
					{canLoadMore ? (
						<button
							type="button"
							className={buttonClass}
							disabled={more.busy}
							onClick={loadOlder}
						>
							Load older events
						</button>
					) : null}
				</LoadGate>
			)}
		</section>
	);
}
