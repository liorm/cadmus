import type { AccountMember, AccountRecord } from "@cadmus/contract/types";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { fieldClass } from "@/components/SettingsRows";
import { LoadGate, SkeletonBlock } from "@/components/Skeleton";
import { TimezoneCombobox } from "@/components/TimezoneCombobox";
import { useCadmus } from "@/context/CadmusContext";
import { useScopedResource } from "@/hooks/useScopedResource";

export function AccountSettingsPage() {
	const { client } = useCadmus();
	const [name, setName] = useState("");
	const [timezone, setTimezone] = useState("UTC");
	const [userId, setUserId] = useState("");
	const [role, setRole] = useState<"member" | "owner">("member");
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
	const formDisabled = busy || loaded.phase !== "ready";

	return (
		<AppShell title="Account" backTo="/settings">
			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-4">
				{loaded.phase === "error" ? (
					<LoadGate
						phase="error"
						error={loaded.error}
						onRetry={loaded.retry}
						label="Loading account"
					>
						{null}
					</LoadGate>
				) : null}
				{loaded.phase === "loading" ? (
					<SkeletonBlock label="Loading account" />
				) : null}
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
								timezone,
							})
							.then((res) => {
								if (!res.ok) {
									setError(
										res.error?.message ?? "Could not update the account",
									);
									return;
								}
								return loaded.retry();
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
					{loaded.phase === "ready" ? (
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
					) : null}
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
									return loaded.retry();
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
								disabled={formDisabled}
								onChange={(event) => setUserId(event.target.value)}
							/>
						</label>
						<label className="flex flex-col gap-1">
							<span>Role</span>
							<select
								aria-label="Member role"
								className={fieldClass}
								value={role}
								disabled={formDisabled}
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
							disabled={formDisabled || !userId.trim()}
						>
							Add member
						</button>
					</form>
				</section>
			</div>
		</AppShell>
	);
}
