import type {
	SystemAccountSummary,
	SystemMetricsResult,
} from "@cadmus/contract/types";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Building2, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { AddEntityDialog } from "@/components/chrome/AddEntityDialog";
import { LoadGate } from "@/components/Skeleton";
import { useCadmus } from "@/context/CadmusContext";
import { useElevation } from "@/context/ElevationContext";
import { useScopedResource } from "@/hooks/useScopedResource";
import { isoTime } from "@/lib/session";
import { cn } from "@/lib/utils";
import { SuperAdminShell } from "@/surfaces/super-admin/SuperAdminShell";

export function SystemTenantsPage() {
	const { client } = useCadmus();
	const { runProtected } = useElevation();

	const loaded = useScopedResource("system-tenants", async () => {
		const [accRes, metRes] = await Promise.all([
			client.callRpc<{ accounts?: SystemAccountSummary[] }>(
				"system.accounts.list",
			),
			client.callRpc<SystemMetricsResult>("system.metrics"),
		]);
		if (!accRes.ok) {
			throw new Error(
				accRes.error?.message ?? "Could not load tenant accounts",
			);
		}
		return {
			accounts: accRes.result?.accounts ?? [],
			perAccount: metRes.ok ? (metRes.result?.perAccount ?? []) : [],
		};
	});

	const [filter, setFilter] = useState("");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [createOpen, setCreateOpen] = useState(false);
	const [name, setName] = useState("");
	const [ownerEmail, setOwnerEmail] = useState("");
	const [renameDraft, setRenameDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const accounts = loaded.data?.accounts ?? [];
	const metricsByAccount = useMemo(
		() =>
			new Map(
				(loaded.data?.perAccount ?? []).map((item) => [item.accountId, item]),
			),
		[loaded.data?.perAccount],
	);

	const filtered = useMemo(() => {
		const q = filter.trim().toLowerCase();
		return [...accounts]
			.filter(
				(a) =>
					!q ||
					a.name.toLowerCase().includes(q) ||
					a.id.toLowerCase().includes(q),
			)
			.sort((a, b) => b.createdAt - a.createdAt);
	}, [accounts, filter]);

	const inspectorAccount =
		accounts.find((a) => a.id === selectedId) ?? filtered[0] ?? null;

	async function handleCreateTenant(e: React.FormEvent) {
		e.preventDefault();
		const cleanName = name.trim();
		const cleanEmail = ownerEmail.trim();
		if (!cleanName || !cleanEmail) return;
		setError(null);
		setNotice(null);
		await runProtected(
			`create tenant "${cleanName}"`,
			`Provisions a new tenant account "${cleanName}" and invites ${cleanEmail} as its initial account-admin.`,
			async () => {
				setBusy(true);
				const res = await client.callRpc<{ account?: SystemAccountSummary }>(
					"system.accounts.create",
					{ name: cleanName, ownerEmail: cleanEmail },
				);
				setBusy(false);
				if (!res.ok) {
					setError(res.error?.message ?? "Could not create tenant.");
					return;
				}
				setName("");
				setOwnerEmail("");
				setCreateOpen(false);
				setNotice(`Created tenant ${res.result?.account?.name ?? cleanName}.`);
				if (res.result?.account) setSelectedId(res.result.account.id);
				loaded.retry();
			},
		);
	}

	async function handleRename(account: SystemAccountSummary) {
		const next = renameDraft.trim();
		if (!next || next === account.name) return;
		setError(null);
		setNotice(null);
		await runProtected(
			`rename "${account.name}" to "${next}"`,
			`Updates the tenant display name for account ${account.id}.`,
			async () => {
				setBusy(true);
				const res = await client.callRpc("system.accounts.rename", {
					accountId: account.id,
					name: next,
				});
				setBusy(false);
				if (!res.ok) {
					setError(res.error?.message ?? "Could not rename tenant.");
					return;
				}
				setRenameDraft("");
				setNotice(`Renamed tenant to ${next}.`);
				loaded.retry();
			},
		);
	}

	async function handleToggleSuspend(account: SystemAccountSummary) {
		const suspend = account.status !== "suspended";
		setError(null);
		setNotice(null);
		await runProtected(
			`${suspend ? "suspend" : "resume"} "${account.name}"`,
			suspend
				? `Blocks logins and active API access for tenant ${account.id}.`
				: `Restores logins and API access for tenant ${account.id}.`,
			async () => {
				setBusy(true);
				const res = await client.callRpc(
					suspend ? "system.accounts.suspend" : "system.accounts.resume",
					{ accountId: account.id },
				);
				setBusy(false);
				if (!res.ok) {
					setError(res.error?.message ?? "Could not update tenant status.");
					return;
				}
				setNotice(
					`${account.name} is now ${suspend ? "suspended" : "active"}.`,
				);
				loaded.retry();
			},
		);
	}

	return (
		<SuperAdminShell
			activeTab="tenants"
			title="Tenant Accounts"
			actions={
				<button
					type="button"
					onClick={() => {
						setError(null);
						setCreateOpen(true);
					}}
					className="inline-flex min-h-tap items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-semibold text-on-accent hover:opacity-90"
				>
					<Plus className="h-3.5 w-3.5" />
					Create tenant
				</button>
			}
		>
			<div className="space-y-4">
				{error ? (
					<p
						role="alert"
						className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
					>
						{error}
					</p>
				) : null}
				{notice ? (
					<p
						role="status"
						className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-accent"
					>
						{notice}
					</p>
				) : null}

				<div className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2">
					<Search className="h-4 w-4 text-text-muted" />
					<input
						aria-label="Filter tenant accounts"
						placeholder="Filter by tenant name or account id…"
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
						className="min-w-0 flex-1 bg-transparent text-xs text-text outline-none"
					/>
				</div>

				<LoadGate
					phase={loaded.phase}
					error={loaded.error}
					onRetry={loaded.retry}
					label="Loading tenant accounts"
				>
					<div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
						{/* Tenant List / Triage Cards */}
						<div className="overflow-hidden rounded-xl border border-border bg-surface">
							{filtered.length === 0 ? (
								<p className="p-6 text-center text-xs text-text-muted">
									No tenant accounts match your filter.
								</p>
							) : (
								<ul className="divide-y divide-border">
									{filtered.map((acc) => {
										const stats = metricsByAccount.get(acc.id);
										const selected = inspectorAccount?.id === acc.id;
										const suspended = acc.status === "suspended";
										return (
											<li
												key={acc.id}
												className={cn(
													"flex flex-col gap-2 p-4 transition sm:flex-row sm:items-center sm:justify-between",
													selected ? "bg-accent/8" : "hover:bg-surface-raised",
												)}
											>
												<button
													type="button"
													onClick={() => {
														setSelectedId(acc.id);
														setRenameDraft(acc.name);
													}}
													className="min-w-0 flex-1 text-left"
												>
													<div className="flex flex-wrap items-center gap-2">
														<Building2 className="h-4 w-4 shrink-0 text-accent" />
														<span className="truncate text-sm font-semibold text-text">
															{acc.name}
														</span>
														<span
															className={
																suspended
																	? "rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-semibold text-destructive"
																	: "rounded-full bg-status-done/15 px-2 py-0.5 text-[10px] font-semibold text-status-done"
															}
														>
															{acc.status}
														</span>
													</div>
													<div className="mt-1 flex flex-wrap gap-3 text-[11px] text-text-muted">
														<span className="font-mono">{acc.id}</span>
														{stats ? (
															<>
																<span>{stats.memberCount} members</span>
																<span>{stats.familyCount} groups</span>
																<span>{stats.activeSessionCount} sessions</span>
															</>
														) : null}
													</div>
												</button>

												<div className="flex shrink-0 items-center gap-2">
													<button
														type="button"
														disabled={busy}
														onClick={() => void handleToggleSuspend(acc)}
														className="rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-text hover:bg-surface-raised lg:hidden"
													>
														{suspended ? "Resume" : "Suspend"}
													</button>
													<Link
														to="/system/tenants/$accountId"
														params={{ accountId: acc.id }}
														className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-accent hover:border-accent/50"
													>
														<span>Details</span>
														<ArrowUpRight className="h-3.5 w-3.5" />
													</Link>
												</div>
											</li>
										);
									})}
								</ul>
							)}
						</div>

						{/* Desktop Quick Inspector */}
						{inspectorAccount ? (
							<aside
								aria-label="Tenant quick inspector"
								className="hidden h-fit space-y-4 rounded-xl border border-border bg-surface p-4 lg:block"
							>
								<div className="flex items-start justify-between gap-2">
									<div className="min-w-0">
										<h2 className="truncate text-sm font-semibold text-text">
											{inspectorAccount.name}
										</h2>
										<p className="truncate font-mono text-[11px] text-text-muted">
											{inspectorAccount.id}
										</p>
									</div>
									<Link
										to="/system/tenants/$accountId"
										params={{ accountId: inspectorAccount.id }}
										className="inline-flex shrink-0 items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-xs font-semibold text-on-accent hover:opacity-90"
									>
										<span>Expand</span>
										<ArrowUpRight className="h-3.5 w-3.5" />
									</Link>
								</div>

								<div className="rounded-lg border border-border bg-bg/50 p-3 text-xs">
									<div className="flex justify-between py-1">
										<span className="text-text-muted">Status</span>
										<span className="font-semibold capitalize text-text">
											{inspectorAccount.status}
										</span>
									</div>
									<div className="flex justify-between py-1">
										<span className="text-text-muted">Created</span>
										<span className="text-text">
											{isoTime(inspectorAccount.createdAt)}
										</span>
									</div>
								</div>

								<div className="space-y-2">
									<label className="block space-y-1">
										<span className="text-xs font-medium text-text-muted">
											Rename tenant
										</span>
										<div className="flex gap-2">
											<input
												aria-label="Quick rename tenant"
												placeholder={inspectorAccount.name}
												value={renameDraft}
												onChange={(e) => setRenameDraft(e.target.value)}
												className="min-h-tap min-w-0 flex-1 rounded-lg border border-border bg-bg px-2.5 text-xs text-text"
											/>
											<button
												type="button"
												disabled={busy || !renameDraft.trim()}
												onClick={() => void handleRename(inspectorAccount)}
												className="min-h-tap rounded-lg border border-border px-3 text-xs font-medium text-text hover:bg-surface-raised disabled:opacity-40"
											>
												Save
											</button>
										</div>
									</label>
								</div>

								<button
									type="button"
									disabled={busy}
									onClick={() => void handleToggleSuspend(inspectorAccount)}
									className={cn(
										"min-h-tap w-full rounded-lg border px-3 text-xs font-semibold",
										inspectorAccount.status === "suspended"
											? "border-accent/40 bg-accent/10 text-accent"
											: "border-destructive/40 bg-destructive/10 text-destructive",
									)}
								>
									{inspectorAccount.status === "suspended"
										? "Resume tenant"
										: "Suspend tenant"}
								</button>
							</aside>
						) : null}
					</div>
				</LoadGate>
			</div>

			<AddEntityDialog
				open={createOpen}
				onClose={() => setCreateOpen(false)}
				title="Create Tenant Account"
				description="Provisions a new isolated customer account and emails an owner invite."
			>
				<form
					onSubmit={(e) => void handleCreateTenant(e)}
					className="space-y-4"
				>
					<label className="block space-y-1">
						<span className="text-xs font-medium text-text-muted">
							Tenant name
						</span>
						<input
							aria-label="Tenant name"
							required
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="e.g. Acme Robotics"
							className="min-h-tap w-full rounded-lg border border-border bg-bg px-3 text-sm text-text outline-none focus:border-accent"
						/>
					</label>
					<label className="block space-y-1">
						<span className="text-xs font-medium text-text-muted">
							Initial admin email
						</span>
						<input
							aria-label="Initial admin email"
							type="email"
							required
							value={ownerEmail}
							onChange={(e) => setOwnerEmail(e.target.value)}
							placeholder="owner@acme.com"
							className="min-h-tap w-full rounded-lg border border-border bg-bg px-3 text-sm text-text outline-none focus:border-accent"
						/>
					</label>
					<div className="flex justify-end gap-2">
						<button
							type="button"
							onClick={() => setCreateOpen(false)}
							className="min-h-tap rounded-lg border border-border px-4 text-xs text-text-muted"
						>
							Cancel
						</button>
						<button
							type="submit"
							disabled={busy || !name.trim() || !ownerEmail.trim()}
							className="min-h-tap rounded-lg bg-accent px-4 text-xs font-semibold text-on-accent disabled:opacity-50"
						>
							{busy ? "Creating…" : "Create tenant"}
						</button>
					</div>
				</form>
			</AddEntityDialog>
		</SuperAdminShell>
	);
}
