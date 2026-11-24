import type {
	SystemAccountsGetResult,
	SystemMember,
} from "@cadmus/contract/types";
import { Link } from "@tanstack/react-router";
import {
	ArrowLeft,
	KeyRound,
	Plus,
	ShieldAlert,
	ShieldCheck,
	Trash2,
	UserX,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AddEntityDialog } from "@/components/chrome/AddEntityDialog";
import { LoadGate } from "@/components/Skeleton";
import { useCadmus } from "@/context/CadmusContext";
import { useElevation } from "@/context/ElevationContext";
import { useScopedResource } from "@/hooks/useScopedResource";
import { isoTime } from "@/lib/session";
import { SuperAdminShell } from "@/surfaces/super-admin/SuperAdminShell";

export function SystemTenantDetailPage({ accountId }: { accountId: string }) {
	const { client } = useCadmus();
	const { maybeOn, toggle, runProtected } = useElevation();

	const detail = useScopedResource(`system-account:${accountId}`, async () => {
		const res = await client.callRpc<SystemAccountsGetResult>(
			"system.accounts.get",
			{ accountId },
		);
		if (!res.ok || !res.result) {
			throw new Error(res.error?.message ?? "Could not load tenant details");
		}
		return res.result;
	});

	const [members, setMembers] = useState<SystemMember[] | null>(null);
	const [membersLoading, setMembersLoading] = useState(false);
	const [membersError, setMembersError] = useState<string | null>(null);
	const [renameInput, setRenameInput] = useState("");
	const [inviteOpen, setInviteOpen] = useState(false);
	const [inviteEmail, setInviteEmail] = useState("");
	const [inviteAdmin, setInviteAdmin] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const loadMembers = useCallback(async () => {
		if (!maybeOn) return;
		setMembersLoading(true);
		setMembersError(null);
		const res = await client.callRpc<{ members?: SystemMember[] }>(
			"system.members.list",
			{ accountId },
		);
		setMembersLoading(false);
		if (!res.ok) {
			setMembersError(res.error?.message ?? "Could not load tenant members.");
			return;
		}
		setMembers(res.result?.members ?? []);
	}, [accountId, client, maybeOn]);

	useEffect(() => {
		if (maybeOn) void loadMembers();
		else setMembers(null);
	}, [maybeOn, loadMembers]);

	useEffect(() => {
		if (detail.data?.account.name) {
			setRenameInput(detail.data.account.name);
		}
	}, [detail.data?.account.name]);

	const data = detail.data;

	async function handleRename(e: React.FormEvent) {
		e.preventDefault();
		const next = renameInput.trim();
		if (!next || next === data?.account.name) return;
		setError(null);
		setNotice(null);
		await runProtected(
			`rename tenant to "${next}"`,
			`Changes tenant ${accountId} display name to "${next}".`,
			async () => {
				setBusy(true);
				const res = await client.callRpc("system.accounts.rename", {
					accountId,
					name: next,
				});
				setBusy(false);
				if (!res.ok) {
					setError(res.error?.message ?? "Could not rename tenant.");
					return;
				}
				setNotice(`Tenant renamed to ${next}.`);
				detail.retry();
			},
		);
	}

	async function handleToggleSuspend() {
		if (!data) return;
		const suspend = data.account.status !== "suspended";
		setError(null);
		setNotice(null);
		await runProtected(
			`${suspend ? "suspend" : "resume"} ${data.account.name}`,
			suspend
				? `Suspends tenant ${accountId} and blocks user sign-ins.`
				: `Resumes tenant ${accountId} and re-enables user sign-ins.`,
			async () => {
				setBusy(true);
				const res = await client.callRpc(
					suspend ? "system.accounts.suspend" : "system.accounts.resume",
					{ accountId },
				);
				setBusy(false);
				if (!res.ok) {
					setError(res.error?.message ?? "Could not update tenant status.");
					return;
				}
				setNotice(`Tenant ${suspend ? "suspended" : "resumed"}.`);
				detail.retry();
			},
		);
	}

	async function handleRevokeSession(sessionId: string) {
		setError(null);
		setNotice(null);
		await runProtected(
			`revoke session ${sessionId}`,
			`Immediately terminates session ${sessionId} in tenant ${accountId}.`,
			async () => {
				setBusy(true);
				const res = await client.callRpc("system.sessions.revoke", {
					sessionId,
					accountId,
				});
				setBusy(false);
				if (!res.ok) {
					setError(res.error?.message ?? "Could not revoke session.");
					return;
				}
				setNotice(`Session ${sessionId} revoked.`);
				detail.retry();
			},
		);
	}

	async function handleInviteMember(e: React.FormEvent) {
		e.preventDefault();
		const clean = inviteEmail.trim();
		if (!clean) return;
		const roles: Array<"user" | "account-admin"> = inviteAdmin
			? ["user", "account-admin"]
			: ["user"];
		setError(null);
		setNotice(null);
		await runProtected(
			`invite ${clean} to ${accountId}`,
			`Adds or invites ${clean} into tenant ${accountId} with roles (${roles.join(", ")}).`,
			async () => {
				setBusy(true);
				const res = await client.callRpc("system.members.invite", {
					accountId,
					email: clean,
					roles,
				});
				setBusy(false);
				if (!res.ok) {
					setError(res.error?.message ?? "Could not invite member.");
					return;
				}
				setInviteEmail("");
				setInviteOpen(false);
				setNotice(`Invited ${clean}.`);
				detail.retry();
				await loadMembers();
			},
		);
	}

	async function handleToggleUserDisabled(member: SystemMember) {
		const isDisabled = Boolean(member.disabledAt);
		setError(null);
		setNotice(null);
		await runProtected(
			`${isDisabled ? "enable" : "disable"} user ${member.email || member.userId}`,
			isDisabled
				? `Re-enables global platform access for ${member.email || member.userId}.`
				: `Disables global platform access and active sessions for ${member.email || member.userId}.`,
			async () => {
				setBusy(true);
				const res = await client.callRpc(
					isDisabled ? "system.users.enable" : "system.users.disable",
					{ userId: member.userId },
				);
				setBusy(false);
				if (!res.ok) {
					setError(res.error?.message ?? "Could not update user state.");
					return;
				}
				setNotice(
					`User ${member.email || member.userId} ${isDisabled ? "enabled" : "disabled"}.`,
				);
				await loadMembers();
			},
		);
	}

	async function handleRemoveMember(member: SystemMember) {
		setError(null);
		setNotice(null);
		await runProtected(
			`remove ${member.email || member.userId} from tenant`,
			`Removes ${member.email || member.userId} from tenant ${accountId}.`,
			async () => {
				setBusy(true);
				const res = await client.callRpc("system.members.remove", {
					accountId,
					userId: member.userId,
				});
				setBusy(false);
				if (!res.ok) {
					setError(res.error?.message ?? "Could not remove member.");
					return;
				}
				setNotice(`Removed ${member.email || member.userId}.`);
				await loadMembers();
			},
		);
	}

	return (
		<SuperAdminShell
			activeTab="tenants"
			title={data ? `Tenant · ${data.account.name}` : `Tenant · ${accountId}`}
		>
			<div className="space-y-6">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<Link
						to="/system/tenants"
						className="inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:underline"
					>
						<ArrowLeft className="h-3.5 w-3.5" />
						Tenant Accounts
					</Link>
				</div>

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

				<LoadGate
					phase={detail.phase}
					error={detail.error}
					onRetry={detail.retry}
					label="Loading tenant details"
				>
					{data ? (
						<div className="space-y-6">
							{/* Summary KPIs */}
							<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
								<div className="rounded-xl border border-border bg-surface p-4">
									<div className="text-xs text-text-muted">Bot Groups</div>
									<div className="mt-1 text-xl font-semibold text-text">
										{data.familyCount}
									</div>
								</div>
								<div className="rounded-xl border border-border bg-surface p-4">
									<div className="text-xs text-text-muted">Active Sessions</div>
									<div className="mt-1 text-xl font-semibold text-text">
										{data.activeSessionCount}
									</div>
								</div>
								<div className="rounded-xl border border-border bg-surface p-4">
									<div className="text-xs text-text-muted">Pending Invites</div>
									<div className="mt-1 text-xl font-semibold text-text">
										{data.pendingInviteCount}
									</div>
								</div>
								<div className="rounded-xl border border-border bg-surface p-4">
									<div className="text-xs text-text-muted">
										24h Audit Events
									</div>
									<div className="mt-1 text-xl font-semibold text-text">
										{data.auditEvents24h}
									</div>
								</div>
							</div>

							{/* Governance Controls & Providers */}
							<div className="grid gap-4 md:grid-cols-2">
								<section className="space-y-3 rounded-xl border border-border bg-surface p-4">
									<div className="flex items-center justify-between gap-2">
										<h2 className="text-sm font-semibold text-text">
											Tenant Lifecycle
										</h2>
										<span
											className={
												data.account.status === "suspended"
													? "rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-semibold text-destructive"
													: "rounded-full bg-status-done/15 px-2 py-0.5 text-[10px] font-semibold text-status-done"
											}
										>
											{data.account.status}
										</span>
									</div>
									<form
										onSubmit={(e) => void handleRename(e)}
										className="flex gap-2"
									>
										<input
											aria-label="Rename tenant"
											value={renameInput}
											onChange={(e) => setRenameInput(e.target.value)}
											className="min-h-tap min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 text-xs text-text"
										/>
										<button
											type="submit"
											disabled={busy || !renameInput.trim()}
											className="min-h-tap rounded-lg bg-accent px-3 text-xs font-semibold text-on-accent disabled:opacity-50"
										>
											Rename
										</button>
									</form>
									<button
										type="button"
										disabled={busy}
										onClick={() => void handleToggleSuspend()}
										className={
											data.account.status === "suspended"
												? "min-h-tap w-full rounded-lg border border-accent/40 bg-accent/10 px-3 text-xs font-semibold text-accent"
												: "min-h-tap w-full rounded-lg border border-destructive/40 bg-destructive/10 px-3 text-xs font-semibold text-destructive"
										}
									>
										{data.account.status === "suspended"
											? "Resume tenant account"
											: "Suspend tenant account"}
									</button>
								</section>

								<section className="space-y-3 rounded-xl border border-border bg-surface p-4">
									<div className="flex items-center gap-2 text-sm font-semibold text-text">
										<KeyRound className="h-4 w-4 text-accent" />
										<span>Connected Providers</span>
									</div>
									<p className="text-xs text-text-muted">
										Configured AI provider IDs on this tenant (keys are never
										exposed):
									</p>
									{data.connectedProviders.length === 0 ? (
										<p className="text-xs text-text-muted">
											No credentials configured.
										</p>
									) : (
										<div className="flex flex-wrap gap-1.5">
											{data.connectedProviders.map((pid) => (
												<span
													key={pid}
													className="rounded-full border border-border bg-bg px-2.5 py-1 font-mono text-xs text-text"
												>
													{pid}
												</span>
											))}
										</div>
									)}
								</section>
							</div>

							{/* Active Sessions Table */}
							<section className="overflow-hidden rounded-xl border border-border bg-surface">
								<div className="border-b border-border px-4 py-3">
									<h2 className="text-sm font-semibold text-text">
										Active Sessions ({data.activeSessions.length})
									</h2>
									<p className="text-xs text-text-muted">
										Force-revoke any compromised web or CLI session immediately
									</p>
								</div>
								{data.activeSessions.length === 0 ? (
									<p className="p-4 text-xs text-text-muted">
										No active sessions for this tenant.
									</p>
								) : (
									<ul className="divide-y divide-border">
										{data.activeSessions.map((sess) => (
											<li
												key={sess.id}
												className="flex flex-col justify-between gap-2 p-4 sm:flex-row sm:items-center"
											>
												<div className="min-w-0">
													<div className="truncate text-xs font-semibold text-text">
														{sess.userName || sess.userEmail || sess.userId}
														{sess.userEmail && sess.userName
															? ` (${sess.userEmail})`
															: ""}
													</div>
													<div className="truncate text-[11px] text-text-muted">
														<span className="font-mono">{sess.id}</span> ·{" "}
														{sess.client}
														{sess.ipCountry ? ` · ${sess.ipCountry}` : ""} ·
														last used {isoTime(sess.lastUsedAt)}
													</div>
												</div>
												<button
													type="button"
													disabled={busy}
													onClick={() => void handleRevokeSession(sess.id)}
													className="min-h-tap shrink-0 rounded-lg border border-destructive/40 px-3 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-40"
												>
													Force revoke
												</button>
											</li>
										))}
									</ul>
								)}
							</section>

							{/* Tenant Members (requires elevated admin mode on read) */}
							<section className="overflow-hidden rounded-xl border border-border bg-surface">
								<div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
									<div>
										<h2 className="text-sm font-semibold text-text">
											Tenant Members
										</h2>
										<p className="text-xs text-text-muted">
											Invite members, remove memberships, or disable/enable user
											accounts
										</p>
									</div>
									<button
										type="button"
										onClick={() => setInviteOpen(true)}
										className="inline-flex min-h-tap items-center gap-1 rounded-lg bg-accent px-3 text-xs font-semibold text-on-accent"
									>
										<Plus className="h-3.5 w-3.5" />
										Invite
									</button>
								</div>

								{!maybeOn ? (
									<div className="flex flex-col items-start gap-3 p-4">
										<p className="flex items-center gap-1.5 text-xs text-text-muted">
											<ShieldAlert className="h-4 w-4 text-status-needs-you" />
											Reading and modifying tenant member rosters requires Admin
											mode.
										</p>
										<button
											type="button"
											onClick={() => void toggle(true)}
											className="inline-flex min-h-tap items-center gap-1.5 rounded-lg bg-status-needs-you px-3 text-xs font-semibold text-black"
										>
											<ShieldCheck className="h-3.5 w-3.5" />
											Arm Admin Mode &amp; Load Members
										</button>
									</div>
								) : membersLoading ? (
									<p className="p-4 text-xs text-text-muted">
										Loading tenant members…
									</p>
								) : membersError ? (
									<p className="p-4 text-xs text-destructive">{membersError}</p>
								) : !members || members.length === 0 ? (
									<p className="p-4 text-xs text-text-muted">
										No members found in this tenant.
									</p>
								) : (
									<ul className="divide-y divide-border">
										{members.map((member) => (
											<li
												key={member.userId}
												className="flex flex-col justify-between gap-3 p-4 sm:flex-row sm:items-center"
											>
												<div className="min-w-0">
													<div className="flex flex-wrap items-center gap-2">
														<span className="truncate text-xs font-semibold text-text">
															{member.name || member.email || member.userId}
														</span>
														{member.disabledAt ? (
															<span className="rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-semibold text-destructive">
																Disabled
															</span>
														) : null}
														{member.roles.map((r) => (
															<span
																key={r}
																className="rounded-full border border-border bg-bg px-2 py-0.5 text-[10px] text-text-muted"
															>
																{r}
															</span>
														))}
													</div>
													<div className="mt-0.5 truncate text-[11px] text-text-muted">
														{member.email ? `${member.email} · ` : ""}
														<span className="font-mono">{member.userId}</span>
													</div>
												</div>
												<div className="flex flex-wrap gap-2">
													<button
														type="button"
														disabled={busy}
														onClick={() =>
															void handleToggleUserDisabled(member)
														}
														className="inline-flex min-h-tap items-center gap-1 rounded-lg border border-border px-2.5 text-xs font-medium text-text hover:bg-surface-raised disabled:opacity-40"
													>
														<UserX className="h-3.5 w-3.5" />
														{member.disabledAt ? "Enable user" : "Disable user"}
													</button>
													<button
														type="button"
														disabled={busy}
														onClick={() => void handleRemoveMember(member)}
														className="inline-flex min-h-tap items-center gap-1 rounded-lg border border-destructive/40 px-2.5 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-40"
													>
														<Trash2 className="h-3.5 w-3.5" />
														Remove
													</button>
												</div>
											</li>
										))}
									</ul>
								)}
							</section>
						</div>
					) : null}
				</LoadGate>
			</div>

			<AddEntityDialog
				open={inviteOpen}
				onClose={() => setInviteOpen(false)}
				title={`Invite member to ${data?.account.name ?? accountId}`}
			>
				<form
					onSubmit={(e) => void handleInviteMember(e)}
					className="space-y-4"
				>
					<label className="block space-y-1">
						<span className="text-xs font-medium text-text-muted">Email</span>
						<input
							aria-label="Member email"
							type="email"
							required
							value={inviteEmail}
							onChange={(e) => setInviteEmail(e.target.value)}
							placeholder="admin@tenant.com"
							className="min-h-tap w-full rounded-lg border border-border bg-bg px-3 text-sm text-text"
						/>
					</label>
					<label className="flex items-center gap-2 text-xs text-text">
						<input
							type="checkbox"
							checked={inviteAdmin}
							onChange={(e) => setInviteAdmin(e.target.checked)}
						/>
						Grant Account Admin role (plus User)
					</label>
					<div className="flex justify-end gap-2">
						<button
							type="button"
							onClick={() => setInviteOpen(false)}
							className="min-h-tap rounded-lg border border-border px-4 text-xs text-text-muted"
						>
							Cancel
						</button>
						<button
							type="submit"
							disabled={busy || !inviteEmail.trim()}
							className="min-h-tap rounded-lg bg-accent px-4 text-xs font-semibold text-on-accent disabled:opacity-50"
						>
							Send invite
						</button>
					</div>
				</form>
			</AddEntityDialog>
		</SuperAdminShell>
	);
}
