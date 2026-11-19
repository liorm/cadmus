import type {
	SystemAccountSummary,
	SystemAuditEvent,
	SystemMember,
} from "@cadmus/contract/types";
import { useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { ElevationHelp } from "@/components/ElevationHelp";
import { fieldClass } from "@/components/SettingsRows";
import { LoadGate } from "@/components/Skeleton";
import { useCadmus } from "@/context/CadmusContext";
import { useElevation } from "@/context/ElevationContext";
import { useSession } from "@/context/SessionContext";
import { useScopedResource } from "@/hooks/useScopedResource";
import { isoTime } from "@/lib/session";

const buttonClass = "min-h-tap rounded-md border border-border px-3";
const dangerClass = `${buttonClass} text-destructive`;
const PAGE = 25;

type Reply = {
	ok: boolean;
	error?: { code?: string; message?: string };
	result?: unknown;
};

/** Super-admin console: tenant accounts, their members and users, and the system audit. */
export function SystemConsolePage() {
	const session = useSession();
	const principalPending = session.signedIn && session.principal === null;
	const allowed =
		session.principal?.kind === "user" &&
		!session.principal.viaToken &&
		session.principal.role === "super-admin";
	return (
		<AppShell title="System console" backTo="/settings">
			{principalPending ? (
				<p className="px-3 py-4 text-text-muted">Loading...</p>
			) : allowed ? (
				<Console />
			) : (
				<p role="alert" className="px-3 py-4 text-text-muted">
					The system console is only for super-admins on a signed-in session.
				</p>
			)}
		</AppShell>
	);
}

function Console() {
	const { client } = useCadmus();
	const elevation = useElevation();
	const [error, setError] = useState<{ code?: string; text: string } | null>(
		null,
	);
	const [busy, setBusy] = useState(false);
	const [selected, setSelected] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [ownerEmail, setOwnerEmail] = useState("");
	// The list is every tenant. Mounting them all freezes the page once the
	// catalog is large, so the console shows the newest page and reveals more
	// on request. Newest first: a row just created is on the first page.
	const [shownAccounts, setShownAccounts] = useState(PAGE);
	// Bumped after every successful change so the audit list re-reads.
	const [auditVersion, setAuditVersion] = useState(0);
	// An open member list that needs admin mode shows the recovery itself, so the page-level one stays quiet.
	const [memberNeeds, setMemberNeeds] = useState(false);
	const memberRetry = useRef<() => void>(() => {});

	// Once admin mode is known to be on, an earlier "needs admin mode" refusal is stale.
	useEffect(() => {
		if (typeof elevation.until === "number") {
			setError((prev) => (prev?.code === "elevation_required" ? null : prev));
		}
	}, [elevation.until]);

	const accounts = useScopedResource("system-accounts", async () => {
		const res = await client.callRpc<{ accounts?: SystemAccountSummary[] }>(
			"system.accounts.list",
		);
		if (!res.ok) throw new Error(res.error?.message ?? "Could not load");
		return res.result?.accounts ?? [];
	});

	const applyAccount = (result: unknown) => {
		if (!result || typeof result !== "object" || !("account" in result)) {
			return;
		}
		const account = (result as { account?: SystemAccountSummary }).account;
		if (!account) return;
		accounts.patch((list) => {
			const exists = list.some((item) => item.id === account.id);
			return exists
				? list.map((item) => (item.id === account.id ? account : item))
				: [account, ...list];
		});
	};

	const run = async (fn: () => Promise<Reply>, after: () => void) => {
		setBusy(true);
		setError(null);
		try {
			const res = await fn();
			if (!res.ok) {
				setError({
					code: res.error?.code,
					text: res.error?.message ?? "That did not work",
				});
				return;
			}
			applyAccount(res.result);
			setAuditVersion((v) => v + 1);
			after();
		} catch (err: unknown) {
			// The change may or may not have reached the server, so re-read before retrying.
			setError({
				text: `${err instanceof Error ? err.message : "Network error"}. The change may not have applied: check the list before trying again.`,
			});
			setAuditVersion((v) => v + 1);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 py-4">
			<p className="text-[length:var(--fs-sm)] text-text-muted">
				Accounts, members and sign-ins across the system. Changes need admin
				mode and are written to the system audit. Tenant data is not shown here.
			</p>
			{error ? (
				<div role="alert" className="flex flex-col gap-2 text-destructive">
					<span>{error.text}</span>
				</div>
			) : null}
			<ElevationHelp
				needed={memberNeeds || error?.code === "elevation_required"}
				onEnabled={() => memberRetry.current()}
			/>

			<section aria-label="Accounts" className="flex flex-col gap-2">
				<h2 className="text-[length:var(--fs-xs)] font-semibold uppercase tracking-wide text-text-muted">
					Accounts
				</h2>
				<form
					className="flex flex-wrap gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						const trimmed = name.trim();
						const email = ownerEmail.trim();
						if (!trimmed || !email) return;
						void run(
							() =>
								client.callRpc("system.accounts.create", {
									name: trimmed,
									ownerEmail: email,
								}),
							() => {
								setName("");
								setOwnerEmail("");
								accounts.retry();
							},
						);
					}}
				>
					<input
						aria-label="New account name"
						placeholder="New account name"
						className={`${fieldClass} min-w-0 flex-1`}
						value={name}
						disabled={busy}
						onChange={(event) => setName(event.target.value)}
					/>
					<input
						aria-label="Owner email"
						placeholder="Owner email"
						className={`${fieldClass} min-w-0 flex-1`}
						value={ownerEmail}
						disabled={busy}
						onChange={(event) => setOwnerEmail(event.target.value)}
					/>
					<button type="submit" className={buttonClass} disabled={busy}>
						Create account
					</button>
				</form>
				<LoadGate
					phase={accounts.phase}
					error={accounts.error}
					onRetry={accounts.retry}
					label="Loading accounts"
				>
					<AccountList
						accounts={accounts.data ?? []}
						shown={shownAccounts}
						onShowMore={() => setShownAccounts((count) => count + PAGE)}
						busy={busy}
						selected={selected}
						onToggle={(accountId) =>
							setSelected(selected === accountId ? null : accountId)
						}
						onNeedsAdmin={(needs, retry) => {
							memberRetry.current = retry;
							setMemberNeeds(needs);
						}}
						run={run}
						reload={accounts.retry}
					/>
				</LoadGate>
			</section>

			<AuditSection version={auditVersion} />
		</div>
	);
}

function AccountList({
	accounts,
	shown,
	onShowMore,
	busy,
	selected,
	onToggle,
	onNeedsAdmin,
	run,
	reload,
}: {
	accounts: SystemAccountSummary[];
	shown: number;
	onShowMore: () => void;
	busy: boolean;
	selected: string | null;
	onToggle: (accountId: string) => void;
	onNeedsAdmin: (needs: boolean, retry: () => void) => void;
	run: (fn: () => Promise<Reply>, after: () => void) => Promise<void>;
	reload: () => void;
}) {
	const ordered = [...accounts].sort(
		(a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1),
	);
	const visible = ordered.slice(0, shown);
	const hidden = ordered.length - visible.length;
	return (
		<>
			<ul className="m-0 flex list-none flex-col gap-2 p-0">
				{visible.map((account) => (
					<AccountRow
						key={account.id}
						account={account}
						busy={busy}
						open={selected === account.id}
						onToggle={() => onToggle(account.id)}
						onNeedsAdmin={onNeedsAdmin}
						run={run}
						reload={reload}
					/>
				))}
			</ul>
			{hidden > 0 ? (
				<button type="button" className={buttonClass} onClick={onShowMore}>
					Show more accounts
				</button>
			) : null}
		</>
	);
}

function AccountRow({
	account,
	busy,
	open,
	onToggle,
	onNeedsAdmin,
	run,
	reload,
}: {
	account: SystemAccountSummary;
	busy: boolean;
	open: boolean;
	onToggle: () => void;
	onNeedsAdmin: (needs: boolean, retry: () => void) => void;
	run: (fn: () => Promise<Reply>, after: () => void) => Promise<void>;
	reload: () => void;
}) {
	const { client } = useCadmus();
	const [renaming, setRenaming] = useState<string | null>(null);
	const [confirmSuspend, setConfirmSuspend] = useState(false);
	const suspended = account.status === "suspended";
	return (
		<li
			aria-label={`Account ${account.name}`}
			className="flex flex-col gap-2 rounded-md border border-border bg-surface p-3"
		>
			<div className="flex flex-wrap items-center gap-2">
				<span className="min-w-0 flex-1 break-words font-semibold">
					{account.name}
				</span>
				<span
					className={
						suspended ? "text-destructive" : "text-[var(--text-muted)]"
					}
				>
					{suspended ? "Suspended" : "Active"} · {account.memberCount} members
				</span>
			</div>
			<div className="flex flex-wrap gap-2">
				<button
					type="button"
					className={buttonClass}
					aria-expanded={open}
					onClick={onToggle}
				>
					{open ? "Hide members" : "Members"}
				</button>
				<button
					type="button"
					className={buttonClass}
					disabled={busy}
					onClick={() => setRenaming(renaming === null ? account.name : null)}
				>
					Rename
				</button>
				{suspended || confirmSuspend ? (
					<button
						type="button"
						className={suspended ? buttonClass : dangerClass}
						disabled={busy}
						onClick={() => {
							setConfirmSuspend(false);
							void run(
								() =>
									client.callRpc(
										suspended
											? "system.accounts.resume"
											: "system.accounts.suspend",
										{ accountId: account.id },
									),
								reload,
							);
						}}
					>
						{suspended ? "Resume" : "Confirm suspend"}
					</button>
				) : (
					<button
						type="button"
						className={dangerClass}
						disabled={busy}
						onClick={() => setConfirmSuspend(true)}
					>
						Suspend
					</button>
				)}
				{confirmSuspend ? (
					<button
						type="button"
						className={buttonClass}
						onClick={() => setConfirmSuspend(false)}
					>
						Cancel
					</button>
				) : null}
			</div>
			{renaming !== null ? (
				<form
					className="flex flex-wrap gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						const next = renaming.trim();
						if (!next) return;
						void run(
							() =>
								client.callRpc("system.accounts.rename", {
									accountId: account.id,
									name: next,
								}),
							() => {
								setRenaming(null);
								reload();
							},
						);
					}}
				>
					<input
						aria-label={`New name for ${account.name}`}
						placeholder="New name"
						className={`${fieldClass} min-w-0 flex-1`}
						value={renaming}
						onChange={(event) => setRenaming(event.target.value)}
					/>
					<button type="submit" className={buttonClass} disabled={busy}>
						Save name
					</button>
				</form>
			) : null}
			{open ? (
				<Members
					accountId={account.id}
					busy={busy}
					run={run}
					reload={reload}
					onNeedsAdmin={onNeedsAdmin}
				/>
			) : null}
		</li>
	);
}

function Members({
	accountId,
	busy,
	run,
	reload,
	onNeedsAdmin,
}: {
	accountId: string;
	onNeedsAdmin: (needs: boolean, retry: () => void) => void;
	busy: boolean;
	run: (fn: () => Promise<Reply>, after: () => void) => Promise<void>;
	reload: () => void;
}) {
	const { client } = useCadmus();
	const [email, setEmail] = useState("");
	const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
	const [confirmDisable, setConfirmDisable] = useState<string | null>(null);
	const [role, setRole] = useState<"user" | "account-admin">("account-admin");
	const [refusal, setRefusal] = useState<string | undefined>();
	const members = useScopedResource(`system-members:${accountId}`, async () => {
		const res = await client.callRpc<{ members?: SystemMember[] }>(
			"system.members.list",
			{ accountId },
		);
		setRefusal(res.ok ? undefined : res.error?.code);
		if (!res.ok)
			throw new Error(res.error?.message ?? "Could not load members");
		return res.result?.members ?? [];
	});
	const needsAdmin =
		members.phase === "error" && refusal === "elevation_required";
	useEffect(() => {
		onNeedsAdmin(needsAdmin, members.retry);
		return () => onNeedsAdmin(false, () => {});
	}, [needsAdmin, onNeedsAdmin, members.retry]);
	const again = () => {
		members.retry();
		reload();
	};
	return (
		<div className="flex flex-col gap-2 border-t border-border pt-2">
			<form
				className="flex flex-wrap gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					const value = email.trim();
					if (!value) return;
					void run(
						() =>
							client.callRpc("system.members.invite", {
								accountId,
								email: value,
								roles: [role],
							}),
						() => setEmail(""),
					);
				}}
			>
				<input
					aria-label="Invite email"
					placeholder="Invite by email"
					type="email"
					className={`${fieldClass} min-w-0 flex-1`}
					value={email}
					onChange={(event) => setEmail(event.target.value)}
				/>
				<select
					aria-label="Invite role"
					className={fieldClass}
					value={role}
					onChange={(event) =>
						setRole(event.target.value === "user" ? "user" : "account-admin")
					}
				>
					<option value="account-admin">Account admin</option>
					<option value="user">User</option>
				</select>
				<button type="submit" className={buttonClass} disabled={busy}>
					Invite
				</button>
			</form>
			<LoadGate
				phase={members.phase}
				error={members.error}
				onRetry={members.retry}
				label="Loading members"
			>
				<ul className="m-0 flex list-none flex-col gap-2 p-0">
					{(members.data ?? []).map((member) => {
						const label = member.email ?? member.name;
						return (
							<li
								key={member.userId}
								aria-label={`Member ${label}`}
								className="flex flex-col gap-1 rounded-md border border-border p-2"
							>
								<span className="break-all">
									{label} · {(member.roles ?? []).join(", ")}
									{member.disabledAt ? " · disabled" : ""}
								</span>
								{confirmDisable === member.userId ? (
									<fieldset
										aria-label={`Disable ${label}`}
										className="m-0 flex min-w-0 flex-col gap-2 rounded-md border border-destructive p-2"
									>
										<span className="break-words">
											Disable {label} in every account? This signs them out
											everywhere and they cannot sign in until enabled again. It
											is not limited to this account.
										</span>
										<div className="flex flex-wrap gap-2">
											<button
												type="button"
												className={dangerClass}
												disabled={busy}
												onClick={() => {
													setConfirmDisable(null);
													void run(
														() =>
															client.callRpc("system.users.disable", {
																userId: member.userId,
															}),
														again,
													);
												}}
											>
												Confirm disable in all accounts
											</button>
											<button
												type="button"
												className={buttonClass}
												onClick={() => setConfirmDisable(null)}
											>
												Cancel
											</button>
										</div>
									</fieldset>
								) : null}
								<div className="flex flex-wrap gap-2">
									{(["user", "account-admin"] as const).map((role) => {
										const held = (member.roles ?? []).includes(role);
										return (
											<button
												key={role}
												type="button"
												className={buttonClass}
												disabled={busy}
												onClick={() => {
													void run(
														() =>
															client.callRpc("system.members.update", {
																accountId,
																userId: member.userId,
																op: held ? "revoke" : "grant",
																role,
															}),
														again,
													);
												}}
											>
												{held ? "Remove" : "Add"}{" "}
												{role === "account-admin" ? "account admin" : "user"}
											</button>
										);
									})}
									{member.disabledAt ? (
										<button
											type="button"
											className={buttonClass}
											disabled={busy}
											onClick={() => {
												void run(
													() =>
														client.callRpc("system.users.enable", {
															userId: member.userId,
														}),
													again,
												);
											}}
										>
											Enable user in all accounts
										</button>
									) : (
										<button
											type="button"
											className={dangerClass}
											disabled={busy}
											onClick={() => setConfirmDisable(member.userId)}
										>
											Disable user in all accounts
										</button>
									)}
									<button
										type="button"
										className={buttonClass}
										disabled={busy}
										onClick={() => {
											void run(
												() =>
													client.callRpc("system.users.revokeSessions", {
														userId: member.userId,
													}),
												again,
											);
										}}
									>
										Sign out everywhere
									</button>
									{confirmRemove === member.userId ? (
										<>
											<button
												type="button"
												className={dangerClass}
												disabled={busy}
												onClick={() => {
													setConfirmRemove(null);
													void run(
														() =>
															client.callRpc("system.members.remove", {
																accountId,
																userId: member.userId,
															}),
														again,
													);
												}}
											>
												Confirm remove
											</button>
											<button
												type="button"
												className={buttonClass}
												onClick={() => setConfirmRemove(null)}
											>
												Cancel
											</button>
										</>
									) : (
										<button
											type="button"
											className={dangerClass}
											disabled={busy}
											onClick={() => setConfirmRemove(member.userId)}
										>
											Remove
										</button>
									)}
								</div>
							</li>
						);
					})}
				</ul>
			</LoadGate>
		</div>
	);
}

function AuditSection({ version }: { version: number }) {
	const { client } = useCadmus();
	// Extra pages belong to one first page (`base`). When the first page is
	// re-read, the pages loaded for the old one are ignored, and a Load older
	// that was in flight for the old one is dropped when it returns.
	const [extra, setExtra] = useState<{
		base: SystemAuditEvent[] | null;
		rows: SystemAuditEvent[];
		exhausted: boolean;
	}>({ base: null, rows: [], exhausted: false });
	// Error and the in-flight flag belong to one first page. A new first page
	// shows neither, and does not copy the previous page's older rows.
	const [moreState, setMoreState] = useState<{
		base: SystemAuditEvent[] | null;
		error: string | null;
		loading: boolean;
	}>({ base: null, error: null, loading: false });
	const first = useScopedResource(`system-audit:${version}`, async () => {
		const res = await client.callRpc<{ events?: SystemAuditEvent[] }>(
			"system.audit.list",
			{ limit: PAGE },
		);
		if (!res.ok) throw new Error(res.error?.message ?? "Could not load audit");
		return res.result?.events ?? [];
	});
	const base = first.data ?? null;
	const baseRef = useRef(base);
	baseRef.current = base;
	const current = extra.base === base;
	const older = current ? extra.rows : [];
	const exhausted = current ? extra.exhausted : (base?.length ?? 0) < PAGE;
	const events = [...(base ?? []), ...older];
	const last = events.at(-1);
	const moreCurrent = moreState.base === base;
	const moreError = moreCurrent ? moreState.error : null;
	const loadingMore = moreCurrent ? moreState.loading : false;
	const more = async () => {
		if (!last || !base) return;
		const mine = base;
		setMoreState({ base: mine, error: null, loading: true });
		try {
			const res = await client.callRpc<{ events?: SystemAuditEvent[] }>(
				"system.audit.list",
				{ limit: PAGE, before: last.at, beforeId: last.id },
			);
			if (baseRef.current !== mine) return;
			if (!res.ok) {
				setMoreState({
					base: mine,
					error: res.error?.message ?? "Could not load more",
					loading: false,
				});
				return;
			}
			const next = res.result?.events ?? [];
			setExtra((prev) => ({
				base: mine,
				rows: [...(prev.base === mine ? prev.rows : []), ...next],
				exhausted: next.length < PAGE,
			}));
			setMoreState({ base: mine, error: null, loading: false });
		} catch (err: unknown) {
			if (baseRef.current !== mine) return;
			setMoreState({
				base: mine,
				error: err instanceof Error ? err.message : "Network error",
				loading: false,
			});
		}
	};
	return (
		<section aria-label="System audit" className="flex flex-col gap-2">
			<h2 className="text-[length:var(--fs-xs)] font-semibold uppercase tracking-wide text-text-muted">
				Audit
			</h2>
			<LoadGate
				phase={first.phase}
				error={first.error}
				onRetry={first.retry}
				label="Loading audit"
			>
				<ul className="m-0 flex list-none flex-col gap-1 p-0">
					{events.map((event) => (
						<li
							key={event.id}
							className="rounded-md border border-border p-2 text-[length:var(--fs-sm)]"
						>
							<span className="font-semibold">{event.action}</span>
							<span className="block break-all text-text-muted">
								{event.actorKind}
								{event.actorUserId ? ` ${event.actorUserId}` : ""}
								{event.target ? ` · ${event.target}` : ""}
								{event.data ? ` · ${JSON.stringify(event.data)}` : ""} ·{" "}
								{isoTime(event.at)}
							</span>
						</li>
					))}
				</ul>
				{events.length === 0 ? (
					<p className="text-text-muted">No system changes yet.</p>
				) : null}
				{moreError ? (
					<p role="alert" className="text-destructive">
						{moreError}
					</p>
				) : null}
				{!exhausted && events.length > 0 ? (
					<button
						type="button"
						className={buttonClass}
						disabled={loadingMore}
						onClick={() => {
							void more();
						}}
					>
						Load older
					</button>
				) : null}
			</LoadGate>
		</section>
	);
}
