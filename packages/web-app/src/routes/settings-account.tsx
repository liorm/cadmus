import type { AccountMember, AccountRecord } from "@cadmus/contract/types";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { fieldClass } from "@/components/SettingsRows";
import { useCadmus } from "@/context/CadmusContext";

export function AccountSettingsPage() {
	const { client } = useCadmus();
	const [account, setAccount] = useState<AccountRecord | null>(null);
	const [members, setMembers] = useState<AccountMember[]>([]);
	const [name, setName] = useState("");
	const [timezone, setTimezone] = useState("UTC");
	const [userId, setUserId] = useState("");
	const [role, setRole] = useState<"member" | "owner">("member");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const load = useCallback(async () => {
		const [accountRes, memberRes] = await Promise.all([
			client.callRpc<{ account?: AccountRecord }>("account.get"),
			client.callRpc<{ members?: AccountMember[] }>("account.members.list"),
		]);
		const next = accountRes.result?.account ?? null;
		setAccount(next);
		if (next) {
			setName(next.name);
			setTimezone(next.timezone);
		}
		setMembers(memberRes.result?.members ?? []);
	}, [client]);

	useEffect(() => {
		void load();
	}, [load]);

	return (
		<AppShell title="Account" backTo="/settings">
			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-4">
				{error ? <p className="text-destructive">{error}</p> : null}
				<form
					className="flex flex-col gap-3"
					onSubmit={(event) => {
						event.preventDefault();
						setBusy(true);
						setError(null);
						void client
							.callRpc("account.update", {
								name: name.trim(),
								timezone: timezone.trim(),
							})
							.then((res) => {
								if (!res.ok) {
									setError(
										res.error?.message ?? "Could not update the account",
									);
									return;
								}
								return load();
							})
							.catch((err: unknown) => {
								setError(err instanceof Error ? err.message : "Network error");
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
							required
						/>
					</label>
					<label className="flex flex-col gap-1">
						<span>Timezone</span>
						<input
							aria-label="Account timezone"
							className={fieldClass}
							value={timezone}
							onChange={(event) => setTimezone(event.target.value)}
							required
						/>
					</label>
					<p className="text-[length:var(--fs-sm)] text-text-muted">
						{account ? `Account ${account.id}` : "Loading account…"}
					</p>
					<button
						type="submit"
						className="min-h-tap rounded-md bg-accent text-on-accent"
						disabled={busy}
					>
						Save account
					</button>
				</form>
				<section aria-label="Members" className="flex flex-col gap-2">
					<h2 className="text-[length:var(--fs-xs)] font-semibold uppercase tracking-wide text-text-muted">
						Members
					</h2>
					<ul className="overflow-hidden rounded-md border border-border bg-surface">
						{members.map((member) => (
							<li
								key={member.userId}
								className="flex min-h-tap items-center justify-between border-b border-border px-3 last:border-b-0"
							>
								<span>{member.userId}</span>
								<span className="text-text-muted">{member.role}</span>
							</li>
						))}
					</ul>
					<form
						className="flex flex-col gap-2"
						onSubmit={(event) => {
							event.preventDefault();
							if (!userId.trim()) return;
							setBusy(true);
							setError(null);
							void client
								.callRpc("account.members.add", {
									userId: userId.trim(),
									role,
								})
								.then((res) => {
									if (!res.ok) {
										setError(res.error?.message ?? "Could not add the member");
										return;
									}
									setUserId("");
									return load();
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
								onChange={(event) => setUserId(event.target.value)}
							/>
						</label>
						<label className="flex flex-col gap-1">
							<span>Role</span>
							<select
								aria-label="Member role"
								className={fieldClass}
								value={role}
								onChange={(event) =>
									setRole(event.target.value === "owner" ? "owner" : "member")
								}
							>
								<option value="member">member</option>
								<option value="owner">owner</option>
							</select>
						</label>
						<button
							type="submit"
							className="min-h-tap rounded-md border border-border"
							disabled={busy || !userId.trim()}
						>
							Add member
						</button>
					</form>
				</section>
			</div>
		</AppShell>
	);
}
