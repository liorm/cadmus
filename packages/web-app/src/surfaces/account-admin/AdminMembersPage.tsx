import type {
	AccountInvitesListResult,
	AccountMember,
} from "@cadmus/contract/types";

type InviteRow = AccountInvitesListResult["invites"][number];

import {
	Mail,
	Plus,
	ShieldAlert,
	ShieldCheck,
	Trash2,
	UserPlus,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AddEntityDialog } from "@/components/chrome/AddEntityDialog";
import { LoadGate } from "@/components/Skeleton";
import { useCadmus } from "@/context/CadmusContext";
import { useElevation } from "@/context/ElevationContext";
import { useScopedResource } from "@/hooks/useScopedResource";
import { isoTime } from "@/lib/session";
import { AccountAdminShell } from "@/surfaces/account-admin/AccountAdminShell";

export function AdminMembersPage() {
	const { client } = useCadmus();
	const { maybeOn, toggle, runProtected } = useElevation();

	const loaded = useScopedResource("admin-members", async () => {
		const memRes = await client.callRpc<{ members?: AccountMember[] }>(
			"account.members.list",
		);
		if (!memRes.ok) {
			throw new Error(memRes.error?.message ?? "Could not load members");
		}
		return memRes.result?.members ?? [];
	});

	const [pendingInvites, setPendingInvites] = useState<InviteRow[]>([]);
	const [invitesLoading, setInvitesLoading] = useState(false);

	const loadInvites = useCallback(async () => {
		if (!maybeOn) {
			setPendingInvites([]);
			return;
		}
		setInvitesLoading(true);
		const invRes = await client.callRpc<AccountInvitesListResult>(
			"account.invites.list",
		);
		setInvitesLoading(false);
		if (!invRes.ok) return;
		setPendingInvites(
			(invRes.result?.invites ?? []).filter(
				(i) => !i.acceptedAt && !i.revokedAt,
			),
		);
	}, [client, maybeOn]);

	useEffect(() => {
		void loadInvites();
	}, [loadInvites]);

	const [inviteOpen, setInviteOpen] = useState(false);
	const [email, setEmail] = useState("");
	const [asUser, setAsUser] = useState(true);
	const [asAdmin, setAsAdmin] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const members = loaded.data ?? [];
	const adminCount = members.filter((m) =>
		m.roles.includes("account-admin"),
	).length;

	async function handleInvite(e: React.FormEvent) {
		e.preventDefault();
		const trimmed = email.trim();
		const roles: Array<"user" | "account-admin"> = [
			...(asUser ? (["user"] as const) : []),
			...(asAdmin ? (["account-admin"] as const) : []),
		];
		if (!trimmed || roles.length === 0) return;
		setError(null);
		setNotice(null);
		await runProtected(
			`invite ${trimmed}`,
			`Sends an account invitation with roles (${roles.join(", ")}) to ${trimmed}.`,
			async () => {
				setBusy(true);
				const res = await client.callRpc("account.members.invite", {
					email: trimmed,
					roles,
				});
				setBusy(false);
				if (!res.ok) {
					setError(res.error?.message ?? "Could not send invite.");
					return;
				}
				setEmail("");
				setInviteOpen(false);
				setNotice(`Invited ${trimmed}.`);
				loaded.retry();
				await loadInvites();
			},
		);
	}

	async function handleRoleToggle(
		member: AccountMember,
		role: "user" | "account-admin",
	) {
		const held = member.roles.includes(role);
		setError(null);
		setNotice(null);
		await runProtected(
			`${held ? "revoke" : "grant"} ${role} role`,
			`${held ? "Removes" : "Grants"} the ${role} role for ${member.email || member.name || member.userId}.`,
			async () => {
				setBusy(true);
				const res = await client.callRpc("account.members.update", {
					userId: member.userId,
					op: held ? "revoke" : "grant",
					role,
				});
				setBusy(false);
				if (!res.ok) {
					setError(res.error?.message ?? "Could not update member role.");
					return;
				}
				setNotice(
					`${held ? "Removed" : "Granted"} ${role} for ${member.email || member.userId}.`,
				);
				loaded.retry();
			},
		);
	}

	async function handleRemoveMember(member: AccountMember) {
		setError(null);
		setNotice(null);
		await runProtected(
			`remove ${member.email || member.userId}`,
			`Removes ${member.email || member.userId} from this account and signs them out of it.`,
			async () => {
				setBusy(true);
				const res = await client.callRpc("account.members.remove", {
					userId: member.userId,
				});
				setBusy(false);
				if (!res.ok) {
					setError(res.error?.message ?? "Could not remove member.");
					return;
				}
				setNotice(`Removed ${member.email || member.userId}.`);
				loaded.retry();
			},
		);
	}

	async function handleRevokeInvite(invite: InviteRow) {
		setError(null);
		setNotice(null);
		await runProtected(
			`revoke invite for ${invite.email}`,
			`Revokes pending invitation to ${invite.email}.`,
			async () => {
				setBusy(true);
				const res = await client.callRpc("account.invites.revoke", {
					inviteId: invite.id,
				});
				setBusy(false);
				if (!res.ok) {
					setError(res.error?.message ?? "Could not revoke invite.");
					return;
				}
				setNotice(`Revoked invite for ${invite.email}.`);
				loaded.retry();
				await loadInvites();
			},
		);
	}

	return (
		<AccountAdminShell
			activeTab="members"
			title="Members & Invites"
			actions={
				<button
					type="button"
					onClick={() => {
						setError(null);
						setInviteOpen(true);
					}}
					className="inline-flex min-h-tap items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-semibold text-on-accent hover:opacity-90"
				>
					<Plus className="h-3.5 w-3.5" />
					Invite member
				</button>
			}
		>
			<div className="space-y-6">
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
					phase={loaded.phase}
					error={loaded.error}
					onRetry={loaded.retry}
					label="Loading members and invites"
				>
					<section aria-label="Account members" className="space-y-3">
						<h2 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
							Members ({members.length})
						</h2>
						<div className="overflow-hidden rounded-xl border border-border bg-surface">
							{members.length === 0 ? (
								<p className="p-4 text-xs text-text-muted">No members found.</p>
							) : (
								<ul className="divide-y divide-border">
									{members.map((member) => (
										<li
											key={member.userId}
											className="flex flex-col justify-between gap-3 p-4 sm:flex-row sm:items-center"
										>
											<div className="min-w-0 flex-1">
												<div className="flex flex-wrap items-center gap-2">
													<span className="truncate text-sm font-semibold text-text">
														{member.name || member.email || member.userId}
													</span>
													{member.disabledAt ? (
														<span className="inline-flex items-center gap-1 rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-semibold text-destructive">
															<ShieldAlert className="h-3 w-3" />
															Disabled
														</span>
													) : null}
													{member.roles.map((role) => (
														<span
															key={role}
															className="rounded-full border border-border bg-bg px-2 py-0.5 text-[10px] font-medium text-text-muted"
														>
															{role}
														</span>
													))}
												</div>
												<div className="mt-0.5 truncate text-xs text-text-muted">
													{member.email ? `${member.email} · ` : ""}
													<span className="font-mono">{member.userId}</span> ·
													joined {isoTime(member.createdAt)}
												</div>
											</div>

											<div className="flex flex-wrap items-center gap-2">
												{(["user", "account-admin"] as const).map((role) => {
													const held = member.roles.includes(role);
													const lastRole = held && member.roles.length <= 1;
													const lastAdmin =
														held && role === "account-admin" && adminCount <= 1;
													return (
														<button
															key={role}
															type="button"
															disabled={busy || lastRole || lastAdmin}
															onClick={() =>
																void handleRoleToggle(member, role)
															}
															className="min-h-tap rounded-lg border border-border px-2.5 text-xs font-medium text-text hover:bg-surface-raised disabled:opacity-40"
														>
															{held ? "Revoke" : "Grant"} {role}
														</button>
													);
												})}
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
						</div>
					</section>

					<section aria-label="Pending invites" className="space-y-3">
						<h2 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
							Pending Invites {maybeOn ? `(${pendingInvites.length})` : ""}
						</h2>
						<div className="overflow-hidden rounded-xl border border-border bg-surface">
							{!maybeOn ? (
								<div className="flex flex-col items-start gap-3 p-4">
									<p className="flex items-center gap-1.5 text-xs text-text-muted">
										<ShieldAlert className="h-4 w-4 text-status-needs-you" />
										Viewing and revoking pending invites requires Admin mode.
									</p>
									<button
										type="button"
										onClick={() => void toggle(true)}
										className="inline-flex min-h-tap items-center gap-1.5 rounded-lg bg-status-needs-you px-3 text-xs font-semibold text-black"
									>
										<ShieldCheck className="h-3.5 w-3.5" />
										Arm Admin Mode &amp; Load Invites
									</button>
								</div>
							) : invitesLoading ? (
								<p className="p-4 text-xs text-text-muted">
									Loading pending invites…
								</p>
							) : pendingInvites.length === 0 ? (
								<p className="p-4 text-xs text-text-muted">
									No pending invites.
								</p>
							) : (
								<ul className="divide-y divide-border">
									{pendingInvites.map((invite) => (
										<li
											key={invite.id}
											className="flex items-center justify-between gap-3 p-4"
										>
											<div className="min-w-0">
												<div className="flex items-center gap-2 text-sm font-medium text-text">
													<Mail className="h-3.5 w-3.5 text-text-muted" />
													<span className="truncate">{invite.email}</span>
												</div>
												<div className="mt-0.5 text-xs text-text-muted">
													Roles: {invite.roles.join(", ")}
												</div>
											</div>
											<button
												type="button"
												disabled={busy}
												onClick={() => void handleRevokeInvite(invite)}
												className="min-h-tap rounded-lg border border-border px-3 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-40"
											>
												Revoke
											</button>
										</li>
									))}
								</ul>
							)}
						</div>
					</section>
				</LoadGate>
			</div>

			<AddEntityDialog
				open={inviteOpen}
				onClose={() => setInviteOpen(false)}
				title="Invite Member"
				description="Grant workspace or account governance access by email."
			>
				<form onSubmit={(e) => void handleInvite(e)} className="space-y-4">
					<label className="block space-y-1">
						<span className="text-xs font-medium text-text-muted">
							Email address
						</span>
						<input
							aria-label="Invite email"
							type="email"
							required
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							placeholder="colleague@company.com"
							className="min-h-tap w-full rounded-lg border border-border bg-bg px-3 text-sm text-text outline-none focus:border-accent"
						/>
					</label>
					<div className="space-y-2 rounded-lg border border-border bg-bg/60 p-3">
						<div className="text-xs font-medium text-text-muted">Roles</div>
						<label className="flex items-center gap-2 text-xs text-text">
							<input
								type="checkbox"
								checked={asUser}
								onChange={(e) => setAsUser(e.target.checked)}
							/>
							User (create &amp; converse with bots, manage schedules &amp;
							envs)
						</label>
						<label className="flex items-center gap-2 text-xs text-text">
							<input
								type="checkbox"
								checked={asAdmin}
								onChange={(e) => setAsAdmin(e.target.checked)}
							/>
							Account Admin (manage members, providers, and account audit)
						</label>
					</div>
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
							disabled={busy || !email.trim() || (!asUser && !asAdmin)}
							className="inline-flex min-h-tap items-center gap-1.5 rounded-lg bg-accent px-4 text-xs font-semibold text-on-accent disabled:opacity-50"
						>
							<UserPlus className="h-3.5 w-3.5" />
							{busy ? "Inviting…" : "Send invite"}
						</button>
					</div>
				</form>
			</AddEntityDialog>
		</AccountAdminShell>
	);
}
