import type { AccountInvitesListResult } from "@cadmus/contract/types";

type InviteSummary = AccountInvitesListResult["invites"][number];

import { useEffect, useRef, useState } from "react";
import { fieldClass } from "@/components/SettingsRows";
import { isRefusalMessage } from "@/components/Skeleton";
import { useCadmus } from "@/context/CadmusContext";
import { useScopedResource } from "@/hooks/useScopedResource";

const buttonClass =
	"min-h-tap rounded-md border border-border px-3 disabled:opacity-50";

/**
 * Pending invites, invite and revoke. Inviting and revoking are member
 * management: only shown to those who can manage, and off while `locked`.
 */
export function InviteSection({
	canManage = true,
	locked = false,
	onNeedsAdmin,
}: {
	canManage?: boolean;
	locked?: boolean;
	/** Reports a missing admin mode so the page can show one recovery. */
	onNeedsAdmin?: (needs: boolean) => void;
}) {
	const { client } = useCadmus();
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<"user" | "account-admin">("user");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const loaded = useScopedResource("invites", async () => {
		const res = await client.callRpc<{ invites?: InviteSummary[] }>(
			"account.invites.list",
		);
		if (!res.ok) {
			throw new Error(res.error?.message ?? "Could not load invites");
		}
		return res.result?.invites ?? [];
	});
	// Actions act on the rows on screen, so they stay off until those rows are
	// a fresh read: from the moment a reread is requested until the read that
	// was requested (or a later one) publishes, not until any state changes, and
	// while the last read failed (the old rows are kept but may be out of date).
	const [rereadId, setRereadId] = useState<number | null>(null);
	const ambiguousRef = useRef<string | null>(null);
	const rereading = rereadId !== null && loaded.completed < rereadId;
	const off =
		busy || locked || rereading || loaded.phase !== "ready" || !!loaded.error;
	// An unknown-outcome note is owned here: a fresh successful read clears
	// exactly this note and nothing else.
	const ownNote = (note: string) => {
		ambiguousRef.current = note;
		setError(note);
	};
	const reread = () => {
		setRereadId(loaded.retry());
	};
	useEffect(() => {
		// A fresh successful read after an ambiguous action replaces only that
		// action's note.
		const note = ambiguousRef.current;
		if (note && !rereading && loaded.data && !loaded.error) {
			ambiguousRef.current = null;
			setError((current) => (current === note ? null : current));
		}
	}, [loaded.data, loaded.error, rereading]);
	const pending = (loaded.data ?? []).filter(
		(invite) => !invite.acceptedAt && !invite.revokedAt,
	);
	const run = (
		fn: () => Promise<{
			ok: boolean;
			error?: { code?: string; message?: string };
		}>,
		onOk?: () => void,
	) => {
		if (off || !canManage) return;
		setBusy(true);
		setError(null);
		void fn()
			.then((res) => {
				if (!res.ok) {
					// A known need for admin mode persists across other failures,
					// in-flight actions and successes (a success only proves the
					// admin mode that action started with); a confirmed enable
					// clears it.
					if (res.error?.code === "elevation_required") onNeedsAdmin?.(true);
					// command_failed may come after the change was written (the invite
					// revoke updates the row, then runs a separate audit step that can
					// fail), so the outcome is unknown. Other codes keep the server
					// message; they are not proven to be refusals, only that the
					// reread below settles what is on screen.
					if (res.error?.code === "command_failed") {
						ownNote(
							`${res.error.message ?? "That did not work"}. The change may have applied. Reloading the invites; check them before trying again.`,
						);
					} else {
						setError(res.error?.message ?? "That did not work");
					}
					// An answered failure is not always a no-op (the server may have
					// changed a row before a later step failed), so reread unless the
					// command was refused before it ran.
					if (res.error?.code !== "elevation_required") reread();
					return;
				}
				onOk?.();
				reread();
			})
			.catch((err: unknown) => {
				// No answer arrived, so the change may or may not have applied.
				ownNote(
					`${err instanceof Error ? err.message : "Network error"}. The change may not have applied. Reloading the invites; check them before trying again.`,
				);
				reread();
			})
			.finally(() => setBusy(false));
	};

	return (
		<section aria-label="Invites" className="flex flex-col gap-2">
			<h2 className="text-[length:var(--fs-xs)] font-semibold uppercase tracking-wide text-text-muted">
				Invites
			</h2>
			<p className="text-[length:var(--fs-sm)] text-text-muted">
				An invite is accepted on the first Google sign-in with that email.
			</p>
			{error ? (
				<p role="alert" className="text-destructive">
					{error}
				</p>
			) : null}
			{loaded.error ? (
				<div role="alert" className="flex flex-col items-start gap-2">
					{isRefusalMessage(loaded.error) ? (
						// A refusal does not change on retry, so no Retry here.
						<p className="text-text-muted">
							The server did not allow reading the invite list ({loaded.error}).
						</p>
					) : (
						<>
							<p className="text-destructive">
								The invite list could not be reloaded ({loaded.error}), so what
								you see may be out of date.
							</p>
							<button type="button" className={buttonClass} onClick={reread}>
								Retry
							</button>
						</>
					)}
				</div>
			) : null}
			<ul className="overflow-hidden rounded-md border border-border bg-surface">
				{pending.length === 0 && !loaded.error ? (
					<li className="px-3 py-3 text-text-muted">No pending invites.</li>
				) : null}
				{pending.map((invite) => (
					<li
						key={invite.id}
						className="flex min-h-tap items-center gap-3 border-b border-border px-3 last:border-b-0"
					>
						<span className="min-w-0 flex-1 truncate">{invite.email}</span>
						<span className="text-text-muted">{invite.role}</span>
						{canManage ? (
							<button
								type="button"
								className={buttonClass}
								disabled={off}
								aria-label={`Revoke invite ${invite.email}`}
								onClick={() =>
									run(() =>
										client.callRpc("account.invites.revoke", {
											inviteId: invite.id,
										}),
									)
								}
							>
								Revoke
							</button>
						) : null}
					</li>
				))}
			</ul>
			{canManage ? (
				<form
					className="flex flex-col gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						if (!email.trim()) return;
						run(
							() =>
								client.callRpc("account.members.invite", {
									email: email.trim(),
									role,
								}),
							() => setEmail(""),
						);
					}}
				>
					<label className="flex flex-col gap-1">
						<span>Email</span>
						<input
							aria-label="Invite email"
							type="email"
							className={fieldClass}
							value={email}
							disabled={off}
							onChange={(event) => setEmail(event.target.value)}
						/>
					</label>
					<label className="flex flex-col gap-1">
						<span>Invite role</span>
						<select
							aria-label="Invite role"
							className={fieldClass}
							value={role}
							disabled={off}
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
						className={buttonClass}
						disabled={off || !email.trim()}
					>
						Send invite
					</button>
				</form>
			) : null}
		</section>
	);
}
