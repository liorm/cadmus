import type {
	AccountInvitesListResult,
	AccountMember,
	AccountRecord,
	CredentialSummary,
	ToolsEnvRecord,
} from "@cadmus/contract/types";
import { CheckCircle2, KeyRound, Mail, Shield, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { LoadGate } from "@/components/Skeleton";
import { TimezoneCombobox } from "@/components/TimezoneCombobox";
import { useCadmus } from "@/context/CadmusContext";
import { useElevation } from "@/context/ElevationContext";
import { useScopedResource } from "@/hooks/useScopedResource";
import { AccountAdminShell } from "@/surfaces/account-admin/AccountAdminShell";

export function AdminOverviewPage() {
	const { client } = useCadmus();
	const { runProtected, maybeOn } = useElevation();

	const loaded = useScopedResource(
		`admin-overview:${maybeOn ? "armed" : "ro"}`,
		async () => {
			const [accRes, memRes, invRes, envRes] = await Promise.all([
				client.callRpc<{
					account?: AccountRecord;
					credentials?: CredentialSummary[];
				}>("account.get"),
				client.callRpc<{ members?: AccountMember[] }>("account.members.list"),
				maybeOn
					? client.callRpc<AccountInvitesListResult>("account.invites.list")
					: Promise.resolve({ ok: false as const, result: undefined }),
				client.callRpc<{
					envs?: ToolsEnvRecord[];
					default?: { envId?: string } | null;
				}>("account.toolsEnvs.list"),
			]);
			if (!accRes.ok || !memRes.ok) {
				throw new Error(
					accRes.error?.message ??
						memRes.error?.message ??
						"Could not load account overview",
				);
			}
			return {
				account: accRes.result?.account ?? null,
				credentials: accRes.result?.credentials ?? [],
				members: memRes.result?.members ?? [],
				pendingInvites: invRes.ok
					? (invRes.result?.invites ?? []).filter(
							(i) => !i.acceptedAt && !i.revokedAt,
						)
					: null,
				envs: envRes.ok ? (envRes.result?.envs ?? []) : [],
				defaultEnvId: envRes.ok ? (envRes.result?.default?.envId ?? "") : "",
			};
		},
	);

	const [name, setName] = useState("");
	const [timezone, setTimezone] = useState("UTC");
	const [defaultEnvId, setDefaultEnvId] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [savedNote, setSavedNote] = useState<string | null>(null);

	useEffect(() => {
		if (!loaded.data?.account) return;
		setName(loaded.data.account.name);
		setTimezone(loaded.data.account.timezone);
		setDefaultEnvId(loaded.data.defaultEnvId);
	}, [loaded.data]);

	async function handleSave(e: React.FormEvent) {
		e.preventDefault();
		if (!name.trim()) return;
		setError(null);
		setSavedNote(null);
		await runProtected(
			"save account settings",
			"Updates the account display name, default timezone, and account default tools environment.",
			async () => {
				setSaving(true);
				const res = await client.callRpc("account.update", {
					name: name.trim(),
					timezone,
					defaultToolsEnv: defaultEnvId ? { envId: defaultEnvId } : null,
				});
				setSaving(false);
				if (!res.ok) {
					setError(res.error?.message ?? "Could not update account settings.");
					return;
				}
				setSavedNote("Account profile updated.");
				loaded.retry();
			},
		);
	}

	const data = loaded.data;

	return (
		<AccountAdminShell activeTab="overview" title="Account Overview">
			<LoadGate
				phase={loaded.phase}
				error={loaded.error}
				onRetry={loaded.retry}
				label="Loading account overview"
			>
				<div className="space-y-6">
					{/* KPI Grid */}
					<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
						<div className="rounded-xl border border-border bg-surface p-4">
							<div className="flex items-center justify-between text-xs text-text-muted">
								<span>Status</span>
								<Shield className="h-4 w-4 text-accent" />
							</div>
							<div className="mt-2 text-lg font-semibold text-text">Active</div>
							<div className="mt-0.5 truncate font-mono text-[11px] text-text-muted">
								{data?.account?.id} · {data?.account?.timezone ?? "UTC"}
							</div>
						</div>

						<div className="rounded-xl border border-border bg-surface p-4">
							<div className="flex items-center justify-between text-xs text-text-muted">
								<span>Members</span>
								<Users className="h-4 w-4 text-accent" />
							</div>
							<div className="mt-2 text-lg font-semibold text-text">
								{data?.members.length ?? 0}
							</div>
							<div className="mt-0.5 text-[11px] text-text-muted">
								{
									(data?.members ?? []).filter((m) =>
										m.roles.includes("account-admin"),
									).length
								}{" "}
								admins
							</div>
						</div>

						<div className="rounded-xl border border-border bg-surface p-4">
							<div className="flex items-center justify-between text-xs text-text-muted">
								<span>Pending Invites</span>
								<Mail className="h-4 w-4 text-status-needs-you" />
							</div>
							<div className="mt-2 text-lg font-semibold text-text">
								{data?.pendingInvites ? data.pendingInvites.length : "—"}
							</div>
							<div className="mt-0.5 text-[11px] text-text-muted">
								{data?.pendingInvites
									? "Awaiting acceptance"
									: "Arm admin mode to view"}
							</div>
						</div>

						<div className="rounded-xl border border-border bg-surface p-4">
							<div className="flex items-center justify-between text-xs text-text-muted">
								<span>AI Providers</span>
								<KeyRound className="h-4 w-4 text-status-done" />
							</div>
							<div className="mt-2 text-lg font-semibold text-text">
								{data?.credentials.length ?? 0}
							</div>
							<div className="mt-0.5 text-[11px] text-text-muted">
								Configured credentials
							</div>
						</div>
					</div>

					{/* Account Profile Form */}
					<section className="rounded-xl border border-border bg-surface p-5">
						<div className="mb-4">
							<h2 className="text-sm font-semibold text-text">
								Account Profile &amp; Governance
							</h2>
							<p className="mt-0.5 text-xs text-text-muted">
								Configure account identity, default timezone, and default tools
								environment policy.
							</p>
						</div>

						{error ? (
							<p
								role="alert"
								className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
							>
								{error}
							</p>
						) : null}
						{savedNote ? (
							<p
								role="status"
								className="mb-3 inline-flex items-center gap-1.5 rounded-lg border border-status-done/40 bg-status-done/10 px-3 py-2 text-xs text-status-done"
							>
								<CheckCircle2 className="h-3.5 w-3.5" />
								{savedNote}
							</p>
						) : null}

						<form
							onSubmit={(e) => void handleSave(e)}
							className="grid gap-4 sm:grid-cols-2"
						>
							<label className="block space-y-1">
								<span className="text-xs font-medium text-text-muted">
									Account name
								</span>
								<input
									aria-label="Account name"
									required
									value={name}
									onChange={(e) => setName(e.target.value)}
									className="min-h-tap w-full rounded-lg border border-border bg-bg px-3 text-sm text-text outline-none focus:border-accent"
								/>
							</label>

							<label
								htmlFor="admin-account-timezone"
								className="block space-y-1"
							>
								<span className="text-xs font-medium text-text-muted">
									Default timezone
								</span>
								<TimezoneCombobox
									id="admin-account-timezone"
									label="Default timezone"
									value={timezone}
									onChange={setTimezone}
									className="min-h-tap w-full rounded-lg border border-border bg-bg px-3 text-sm text-text"
								/>
							</label>

							{(data?.envs.length ?? 0) > 0 ? (
								<label className="block space-y-1 sm:col-span-2">
									<span className="text-xs font-medium text-text-muted">
										Account default tools environment
									</span>
									<select
										aria-label="Account default tools environment"
										value={defaultEnvId}
										onChange={(e) => setDefaultEnvId(e.target.value)}
										className="min-h-tap w-full rounded-lg border border-border bg-bg px-3 text-sm text-text"
									>
										<option value="">None (inherit off)</option>
										{data?.envs.map((env) => (
											<option key={env.envId} value={env.envId}>
												{env.label?.trim() || env.envId} · {env.kind}
											</option>
										))}
									</select>
								</label>
							) : null}

							<div className="flex justify-end sm:col-span-2">
								<button
									type="submit"
									disabled={saving || !name.trim()}
									className="min-h-tap rounded-lg bg-accent px-4 text-xs font-semibold text-on-accent hover:opacity-90 disabled:opacity-50"
								>
									{saving ? "Saving…" : "Save changes"}
								</button>
							</div>
						</form>
					</section>
				</div>
			</LoadGate>
		</AccountAdminShell>
	);
}
