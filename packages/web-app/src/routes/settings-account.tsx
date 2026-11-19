import type { AccountMember, AccountRecord } from "@cadmus/contract/types";
import { useEffect, useRef, useState } from "react";
import { AccountSwitcher } from "@/components/AccountSwitcher";
import { AppShell } from "@/components/AppShell";
import { AuditSection } from "@/components/AuditSection";
import { ElevationHelp } from "@/components/ElevationHelp";
import { InviteSection } from "@/components/InviteSection";
import { fieldClass } from "@/components/SettingsRows";
import { LoadGate, SkeletonBlock } from "@/components/Skeleton";
import { TimezoneCombobox } from "@/components/TimezoneCombobox";
import { useCadmus } from "@/context/CadmusContext";
import { useSession } from "@/context/SessionContext";
import { useScopedResource } from "@/hooks/useScopedResource";

export function AccountSettingsPage() {
	const { client } = useCadmus();
	const session = useSession();
	// Callers whose role cannot manage members do not get the controls. whoami
	// does not report a token's persisted grants, so a token session with an
	// account-admin role keeps them and the worker decides (decision 13 allows
	// elevated tokens). No session means the legacy master secret, which acts
	// as account-admin.
	const principal = session.principal;
	const principalPending = session.signedIn && principal === null;
	const canManage = !session.signedIn
		? true
		: principal !== null && principal.role === "account-admin";
	const [needsAdmin, setNeedsAdmin] = useState(false);
	const [locked, setLocked] = useState(false);
	const lockedData = useRef<unknown>(undefined);
	const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [timezone, setTimezone] = useState("UTC");
	const [userId, setUserId] = useState("");
	const [role, setRole] = useState<"user" | "account-admin">("user");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const loaded = useScopedResource("account", async () => {
		const [accountRes, memberRes] = await Promise.all([
			client.callRpc<{ account?: AccountRecord }>("account.get"),
			client.callRpc<{ members?: AccountMember[] }>("account.members.list"),
		]);
		if (!accountRes.ok || !memberRes.ok) {
			throw new Error(
				accountRes.error?.message ??
					memberRes.error?.message ??
					"Could not load account",
			);
		}
		return {
			account: accountRes.result?.account ?? null,
			members: memberRes.result?.members ?? [],
		};
	});
	const account = loaded.data?.account ?? null;
	const members = loaded.data?.members ?? [];
	useEffect(() => {
		if (!loaded.data?.account) return;
		setName(loaded.data.account.name);
		setTimezone(loaded.data.account.timezone);
	}, [loaded.data]);
	const dataRef = useRef(loaded.data);
	dataRef.current = loaded.data;
	// Until a member read succeeds after a change or a failed read, the list on
	// screen is not trusted: member changes stay off. The lock clears only when
	// a read returns new data without an error.
	const reloadMembers = () => {
		lockedData.current = dataRef.current;
		setLocked(true);
		loaded.retry();
	};
	useEffect(() => {
		if (loaded.phase !== "ready") return;
		if (loaded.error !== undefined) {
			if (!locked) {
				lockedData.current = loaded.data;
				setLocked(true);
			}
			return;
		}
		if (locked && loaded.data !== lockedData.current) setLocked(false);
	}, [loaded.phase, loaded.error, loaded.data, locked]);
	const changeMember = (
		call: "account.members.update" | "account.members.remove",
		payload: {
			userId: string;
			op?: "grant" | "revoke";
			role?: "user" | "account-admin";
		},
		done: (result: Record<string, unknown>) => string,
	) => {
		if (memberActionsDisabled) return;
		setBusy(true);
		setError(null);
		setNotice(null);
		void client
			.callRpc<Record<string, unknown>>(call, payload)
			.then((res) => {
				if (!res.ok) {
					if (res.error?.code === "elevation_required") setNeedsAdmin(true);
					setError(res.error?.message ?? "Could not change the member");
					return;
				}
				setConfirmRemove(null);
				const result = res.result ?? {};
				const applied =
					call === "account.members.update"
						? result.updated !== false
						: result.removed !== false;
				setNotice(
					applied
						? done(result)
						: "No change was made: the member was already in that state, or it changed at the same time. The list is being reloaded.",
				);
				reloadMembers();
			})
			.catch((err: unknown) => {
				setError(
					`${err instanceof Error ? err.message : "Network error"}. The change may not have applied. Reloading the account and member list; check it before trying again.`,
				);
				reloadMembers();
			})
			.finally(() => setBusy(false));
	};
	// Changing the account name or timezone needs account.manage, an
	// account-admin grant. The role decides here; the worker has the last word.
	// The members heuristic above also excludes every token session; that does
	// not apply here, because whoami hides a token's grants and a token with an
	// account-admin role may hold account.manage.
	const canSaveAccount = canManage;
	const baseDisabled = busy || loaded.phase !== "ready" || !canSaveAccount;
	// A failed reload leaves the last data on screen. Do not act on it.
	const readFailed = loaded.phase === "ready" && loaded.error !== undefined;
	// After a Save whose outcome is unknown (network error) or that was
	// accepted, the form and the member actions stay off until a read returns
	// fresh data, so a second Save cannot be built on a stale name.
	const formDisabled = baseDisabled || locked || readFailed;
	const memberActionsDisabled = formDisabled;

	return (
		<AppShell title="Account" backTo="/settings">
			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-4">
				{!principalPending && loaded.phase === "error" ? (
					<LoadGate
						phase="error"
						error={loaded.error}
						onRetry={loaded.retry}
						label="Loading account"
					>
						{null}
					</LoadGate>
				) : null}
				{principalPending || loaded.phase === "loading" ? (
					<SkeletonBlock label="Loading account" />
				) : null}
				{error ? <p className="text-destructive">{error}</p> : null}
				{!readFailed && locked ? (
					<p role="status" aria-label="Account reload">
						Reloading the account and member list. The account form and member
						changes stay off until it succeeds, and text you typed in the form
						is replaced by what the server returns.
					</p>
				) : null}
				{!principalPending && readFailed ? (
					<div className="flex flex-col gap-2">
						<p role="alert" className="text-destructive">
							Could not reload the account and member list ({loaded.error}).
							What is on screen may be out of date, so the account form and
							member changes stay off.
						</p>
						<button
							type="button"
							className="min-h-tap self-start rounded-md border border-border px-3"
							onClick={reloadMembers}
						>
							Reload account
						</button>
					</div>
				) : null}
				<ElevationHelp
					needed={needsAdmin}
					onEnabled={() => setNeedsAdmin(false)}
				/>
				{!principalPending ? (
					<>
						<form
							className={`flex flex-col gap-3 ${formDisabled ? "opacity-50" : ""}`}
							onSubmit={(event) => {
								event.preventDefault();
								if (formDisabled) return;
								setBusy(true);
								setError(null);
								void client
									.callRpc("account.update", {
										name: name.trim(),
										timezone,
									})
									.then((res) => {
										if (!res.ok) {
											// A known need for admin mode stays until admin mode is
											// confirmed on; another failure, a network error or a
											// success (which proves only the admin mode its request
											// started with) must not hide the recovery.
											if (res.error?.code === "elevation_required")
												setNeedsAdmin(true);
											setError(
												res.error?.message ?? "Could not update the account",
											);
											return;
										}
										reloadMembers();
									})
									.catch((err: unknown) => {
										setError(
											`${err instanceof Error ? err.message : "Network error"}. The change may not have applied. Reloading the account and member list; check it before trying again.`,
										);
										reloadMembers();
									})
									.finally(() => setBusy(false));
							}}
						>
							<label className="flex flex-col gap-1">
								<span>Name</span>
								<input
									aria-label="Account name"
									className={fieldClass}
									value={name}
									onChange={(event) => setName(event.target.value)}
									disabled={formDisabled}
									required
								/>
							</label>
							<label htmlFor="account-timezone" className="flex flex-col gap-1">
								<span>Timezone</span>
								<TimezoneCombobox
									id="account-timezone"
									label="Account timezone"
									value={timezone}
									disabled={formDisabled}
									className={fieldClass}
									onChange={setTimezone}
								/>
							</label>
							<p className="text-[length:var(--fs-sm)] text-text-muted">
								{account ? `Account ${account.id}` : ""}
							</p>
							<button
								type="submit"
								className="min-h-tap rounded-md bg-accent text-on-accent"
								disabled={formDisabled}
							>
								Save account
							</button>
						</form>
						<section aria-label="Members" className="flex flex-col gap-2">
							<h2 className="text-[length:var(--fs-xs)] font-semibold uppercase tracking-wide text-text-muted">
								Members
							</h2>
							{canManage || principalPending ? null : (
								<p className="text-[length:var(--fs-sm)] text-text-muted">
									Only account admins in admin mode can change members.
								</p>
							)}
							{notice ? (
								<p role="status" aria-label="Member change">
									{notice}
								</p>
							) : null}
							{loaded.phase === "ready" ? (
								<ul className="overflow-hidden rounded-md border border-border bg-surface">
									{members.map((member) => {
										const roles = member.roles ?? [];
										const adminCount = members.filter((row) =>
											row.roles?.includes("account-admin"),
										).length;
										return (
											<li
												key={member.userId}
												aria-label={`Member ${member.userId}`}
												className="flex flex-col gap-2 border-b border-border px-3 py-2 last:border-b-0"
											>
												<span className="flex items-center justify-between gap-3">
													<span className="min-w-0 break-all">
														{member.userId}
													</span>
													<span className="text-text-muted">
														{roles.join(", ")}
													</span>
												</span>
												{canManage ? (
													<span className="flex flex-wrap gap-2">
														{(["user", "account-admin"] as const).map(
															(role) => {
																const held = roles.includes(role);
																const lastRole = held && roles.length <= 1;
																const lastAdmin =
																	held &&
																	role === "account-admin" &&
																	adminCount <= 1;
																return (
																	<button
																		key={role}
																		type="button"
																		className="min-h-tap rounded-md border border-border px-3 disabled:opacity-50"
																		disabled={
																			memberActionsDisabled ||
																			lastRole ||
																			lastAdmin
																		}
																		onClick={() =>
																			changeMember(
																				"account.members.update",
																				{
																					userId: member.userId,
																					op: held ? "revoke" : "grant",
																					role,
																				},
																				() =>
																					held
																						? `Removed ${role}.`
																						: `Added ${role}.`,
																			)
																		}
																	>
																		{held ? "Remove" : "Add"}{" "}
																		{role === "account-admin"
																			? "account admin"
																			: "user"}
																	</button>
																);
															},
														)}
														<button
															type="button"
															className="min-h-tap rounded-md border border-border px-3 text-destructive disabled:opacity-50"
															disabled={memberActionsDisabled}
															onClick={() => setConfirmRemove(member.userId)}
														>
															Remove
														</button>
													</span>
												) : null}
												{canManage && confirmRemove === member.userId ? (
													<fieldset
														aria-label={`Remove ${member.userId}`}
														className="m-0 flex min-w-0 flex-col gap-2 rounded-md border border-destructive p-2"
													>
														<span className="break-words">
															Remove {member.userId} from this account? This
															signs them out of it and revokes their personal
															tokens. They keep access to other accounts.
														</span>
														<span className="flex flex-wrap gap-2">
															<button
																type="button"
																className="min-h-tap rounded-md border border-border px-3 text-destructive disabled:opacity-50"
																disabled={memberActionsDisabled}
																onClick={() =>
																	changeMember(
																		"account.members.remove",
																		{ userId: member.userId },
																		(r) =>
																			`Member removed${
																				typeof r.tokensRevoked === "number"
																					? `; ${r.tokensRevoked} tokens and ${String(
																							r.sessionsRevoked ?? 0,
																						)} sessions revoked`
																					: ""
																			}.`,
																	)
																}
															>
																Confirm remove
															</button>
															<button
																type="button"
																className="min-h-tap rounded-md border border-border px-3 disabled:opacity-50"
																onClick={() => setConfirmRemove(null)}
															>
																Cancel
															</button>
														</span>
													</fieldset>
												) : null}
											</li>
										);
									})}
								</ul>
							) : null}
							{canManage ? (
								<form
									className="flex flex-col gap-2"
									onSubmit={(event) => {
										event.preventDefault();
										if (!userId.trim() || memberActionsDisabled) return;
										setBusy(true);
										setError(null);
										void client
											.callRpc("account.members.add", {
												userId: userId.trim(),
												role,
											})
											.then((res) => {
												if (!res.ok) {
													if (res.error?.code === "elevation_required")
														setNeedsAdmin(true);
													setError(
														res.error?.message ?? "Could not add the member",
													);
													return;
												}
												setUserId("");
												reloadMembers();
											})
											.catch((err: unknown) => {
												setError(
													err instanceof Error ? err.message : "Network error",
												);
											})
											.finally(() => setBusy(false));
									}}
								>
									<label className="flex flex-col gap-1">
										<span>User ID</span>
										<input
											aria-label="Member user ID"
											className={fieldClass}
											value={userId}
											disabled={memberActionsDisabled}
											onChange={(event) => setUserId(event.target.value)}
										/>
									</label>
									<label className="flex flex-col gap-1">
										<span>Role</span>
										<select
											aria-label="Member role"
											className={fieldClass}
											value={role}
											disabled={memberActionsDisabled}
											onChange={(event) =>
												setRole(
													event.target.value === "account-admin"
														? "account-admin"
														: "user",
												)
											}
										>
											<option value="user">user</option>
											<option value="account-admin">account admin</option>
										</select>
									</label>
									<button
										type="submit"
										className="min-h-tap rounded-md border border-border disabled:opacity-50"
										disabled={memberActionsDisabled || !userId.trim()}
									>
										Add member
									</button>
								</form>
							) : null}
						</section>
						<AccountSwitcher />
						<InviteSection
							canManage={canManage}
							locked={memberActionsDisabled}
							onNeedsAdmin={setNeedsAdmin}
						/>
						{canManage ? <AuditSection /> : null}
					</>
				) : null}
			</div>
		</AppShell>
	);
}
