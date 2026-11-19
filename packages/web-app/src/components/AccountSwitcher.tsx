import { fieldClass } from "@/components/SettingsRows";
import { useSession } from "@/context/SessionContext";
import { useMemberships } from "@/hooks/useMemberships";
import { selectAccount } from "@/lib/session";

/**
 * Lists the accounts the user belongs to and acts in the chosen one. The choice
 * is per tab. Switching reloads the page so no data from the previous account
 * stays on screen, and admin mode does not follow: it applies only in the
 * account where it was turned on. Hidden when there is only one account.
 */
export function AccountSwitcher() {
	const session = useSession();
	const memberships = useMemberships();
	const hat = session.principal?.role;
	const sameHat = memberships.filter(
		(membership) => hat && membership.roles.includes(hat),
	);
	if (sameHat.length < 2) return null;
	const current = session.principal?.accountId ?? "";
	return (
		<section className="flex flex-col gap-2" aria-label="Switch account">
			<label className="flex flex-col gap-1">
				<span>Account</span>
				<select
					aria-label="Account"
					className={fieldClass}
					value={current}
					onChange={(event) => {
						const next = event.target.value;
						if (next === current) return;
						selectAccount(next);
						window.location.reload();
					}}
				>
					{sameHat.map((m) => (
						<option key={m.accountId} value={m.accountId}>
							{m.name}
						</option>
					))}
				</select>
			</label>
			<p className="text-[length:var(--fs-sm)] text-muted-foreground">
				Admin mode applies only in the account where you turned it on.
			</p>
		</section>
	);
}
