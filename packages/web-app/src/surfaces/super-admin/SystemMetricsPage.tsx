import type { SystemMetricsResult } from "@cadmus/contract/types";
import { Link } from "@tanstack/react-router";
import {
	Activity,
	Building2,
	FolderKanban,
	ShieldCheck,
	Users,
} from "lucide-react";
import { LoadGate } from "@/components/Skeleton";
import { useCadmus } from "@/context/CadmusContext";
import { useScopedResource } from "@/hooks/useScopedResource";
import { SuperAdminShell } from "@/surfaces/super-admin/SuperAdminShell";

export function SystemMetricsPage() {
	const { client } = useCadmus();
	const loaded = useScopedResource("system-metrics", async () => {
		const res = await client.callRpc<SystemMetricsResult>("system.metrics");
		if (!res.ok || !res.result) {
			throw new Error(res.error?.message ?? "Could not load system metrics");
		}
		return res.result;
	});

	const metrics = loaded.data;

	return (
		<SuperAdminShell activeTab="metrics" title="System Pulse & Metrics">
			<LoadGate
				phase={loaded.phase}
				error={loaded.error}
				onRetry={loaded.retry}
				label="Loading system metrics"
			>
				{metrics ? (
					<div className="space-y-6">
						{/* Platform KPI Cards */}
						<div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
							<div className="rounded-xl border border-border bg-surface p-4">
								<div className="flex items-center justify-between text-xs text-text-muted">
									<span>Tenants</span>
									<Building2 className="h-4 w-4 text-accent" />
								</div>
								<div className="mt-2 text-xl font-semibold text-text">
									{metrics.totalAccounts}
								</div>
								<div className="mt-0.5 text-[11px] text-text-muted">
									{metrics.activeAccounts} active · {metrics.suspendedAccounts}{" "}
									suspended
								</div>
							</div>

							<div className="rounded-xl border border-border bg-surface p-4">
								<div className="flex items-center justify-between text-xs text-text-muted">
									<span>Users</span>
									<Users className="h-4 w-4 text-accent" />
								</div>
								<div className="mt-2 text-xl font-semibold text-text">
									{metrics.totalUsers}
								</div>
								<div className="mt-0.5 text-[11px] text-text-muted">
									{metrics.disabledUsers} disabled · {metrics.pendingInvites}{" "}
									invites
								</div>
							</div>

							<div className="rounded-xl border border-border bg-surface p-4">
								<div className="flex items-center justify-between text-xs text-text-muted">
									<span>Bot Groups</span>
									<FolderKanban className="h-4 w-4 text-accent" />
								</div>
								<div className="mt-2 text-xl font-semibold text-text">
									{metrics.totalFamilies}
								</div>
								<div className="mt-0.5 text-[11px] text-text-muted">
									Isolated DO clusters
								</div>
							</div>

							<div className="rounded-xl border border-border bg-surface p-4">
								<div className="flex items-center justify-between text-xs text-text-muted">
									<span>Active Sessions</span>
									<ShieldCheck className="h-4 w-4 text-status-done" />
								</div>
								<div className="mt-2 text-xl font-semibold text-text">
									{metrics.activeSessions}
								</div>
								<div className="mt-0.5 text-[11px] text-text-muted">
									Live refresh tokens
								</div>
							</div>

							<div className="col-span-2 rounded-xl border border-border bg-surface p-4 lg:col-span-1">
								<div className="flex items-center justify-between text-xs text-text-muted">
									<span>24h Audit</span>
									<Activity className="h-4 w-4 text-status-needs-you" />
								</div>
								<div className="mt-2 text-xl font-semibold text-text">
									{metrics.auditEvents24h}
								</div>
								<div className="mt-0.5 text-[11px] text-text-muted">
									Events across platform
								</div>
							</div>
						</div>

						{/* Per-Account Health Table */}
						<section className="overflow-hidden rounded-xl border border-border bg-surface">
							<div className="flex items-center justify-between border-b border-border px-4 py-3">
								<div>
									<h2 className="text-sm font-semibold text-text">
										Per-Tenant Telemetry
									</h2>
									<p className="text-xs text-text-muted">
										Select any tenant to inspect sessions, members, and status
									</p>
								</div>
								<Link
									to="/system/tenants"
									className="text-xs font-medium text-accent hover:underline"
								>
									Manage all tenants →
								</Link>
							</div>

							{metrics.perAccount.length === 0 ? (
								<p className="p-4 text-xs text-text-muted">
									No tenant accounts provisioned yet.
								</p>
							) : (
								<div className="overflow-x-auto">
									<table className="w-full text-left text-xs">
										<thead className="border-b border-border bg-bg/60 text-[11px] uppercase tracking-wide text-text-muted">
											<tr>
												<th className="px-4 py-2.5">Tenant</th>
												<th className="px-4 py-2.5">Status</th>
												<th className="px-4 py-2.5">Members</th>
												<th className="px-4 py-2.5">Groups</th>
												<th className="px-4 py-2.5">Sessions</th>
												<th className="px-4 py-2.5">Providers</th>
												<th className="px-4 py-2.5">24h Audit</th>
											</tr>
										</thead>
										<tbody className="divide-y divide-border">
											{metrics.perAccount.map((row) => (
												<tr
													key={row.accountId}
													className="hover:bg-surface-raised"
												>
													<td className="px-4 py-3">
														<Link
															to="/system/tenants/$accountId"
															params={{ accountId: row.accountId }}
															className="font-semibold text-accent hover:underline"
														>
															{row.name}
														</Link>
														<div className="font-mono text-[11px] text-text-muted">
															{row.accountId}
														</div>
													</td>
													<td className="px-4 py-3">
														<span
															className={
																row.status === "suspended"
																	? "rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-semibold text-destructive"
																	: "rounded-full bg-status-done/15 px-2 py-0.5 text-[10px] font-semibold text-status-done"
															}
														>
															{row.status}
														</span>
													</td>
													<td className="px-4 py-3 tabular-nums">
														{row.memberCount}
													</td>
													<td className="px-4 py-3 tabular-nums">
														{row.familyCount}
													</td>
													<td className="px-4 py-3 tabular-nums">
														{row.activeSessionCount}
													</td>
													<td className="px-4 py-3 tabular-nums">
														{row.credentialCount}
													</td>
													<td className="px-4 py-3 tabular-nums">
														{row.auditEvents24h}
													</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							)}
						</section>
					</div>
				) : null}
			</LoadGate>
		</SuperAdminShell>
	);
}
