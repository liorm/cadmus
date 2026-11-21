import { useState } from "react";
import { hatChoices } from "@/lib/login-flow";
import {
	clearSelectedAccount,
	type SessionMembership,
	type SessionPrincipal,
} from "@/lib/session";

export interface AssumeRoleSuccess {
	accessToken: string;
	expiresAt: number;
	role: string;
	accountId: string;
}

export function RolePickerCard({
	accessToken,
	principal,
	memberships,
	deviceCode,
	onAssumed,
	onSignOut,
}: {
	accessToken: string;
	principal: SessionPrincipal | null;
	memberships: SessionMembership[];
	deviceCode: string | null;
	onAssumed: (result: AssumeRoleSuccess) => void;
	onSignOut: () => void;
}) {
	const hats = hatChoices(memberships);
	const [picked, setPicked] = useState(0);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const identity = principal?.email ?? principal?.name ?? principal?.userId;

	const submit = async () => {
		const hat = hats[picked] ?? hats[0];
		if (!hat) return;
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/auth/assumeRole", {
				method: "POST",
				credentials: "same-origin",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${accessToken}`,
					Origin: window.location.origin,
				},
				body: JSON.stringify({
					id: "assume-role",
					type: "auth.assumeRole",
					payload: { role: hat.role, accountId: hat.accountId },
				}),
			});
			if (!res.ok) {
				const failed = (await res.json().catch(() => null)) as {
					error?: { code?: string; message?: string };
				} | null;
				setError(
					failed?.error?.code === "role_unchanged"
						? "That is already your active role."
						: (failed?.error?.message ?? "Could not select role"),
				);
				setBusy(false);
				return;
			}
			const body = (await res.json().catch(() => null)) as {
				accessToken?: string;
				expiresAt?: number;
			} | null;
			clearSelectedAccount();
			onAssumed({
				accessToken: body?.accessToken ?? "",
				expiresAt: body?.expiresAt ?? Date.now() + 15 * 60_000,
				role: hat.role,
				accountId: hat.accountId,
			});
		} catch {
			setError("Could not reach the server");
			setBusy(false);
		}
	};

	return (
		<div className="flex min-h-dvh items-center justify-center bg-bg p-6">
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby="role-picker-title"
				className="w-full max-w-sm rounded-lg border border-border bg-surface p-6 shadow-lg"
			>
				<h1
					id="role-picker-title"
					className="text-[length:var(--fs-lg)] font-semibold"
				>
					Choose your role
				</h1>
				<p className="mt-2 text-[length:var(--fs-sm)] text-text-muted">
					{deviceCode
						? `Select which role to wear before approving device ${deviceCode}.`
						: "Select which role and account to use for this session."}
				</p>
				{identity ? (
					<p className="mt-2 text-[length:var(--fs-xs)] text-text-muted">
						Signed in as <span className="text-text">{identity}</span>
					</p>
				) : null}
				{hats.length > 0 ? (
					<form
						className="mt-5 flex flex-col gap-4"
						onSubmit={(event) => {
							event.preventDefault();
							void submit();
						}}
					>
						<fieldset className="flex flex-col gap-2">
							<legend className="mb-1 text-[length:var(--fs-sm)] font-medium">
								Role
							</legend>
							{hats.map((hat, index) => (
								<label
									key={`${hat.accountId}:${hat.role}`}
									className="flex min-h-tap cursor-pointer items-center gap-3 rounded-md border border-border bg-bg px-3 py-2 text-[length:var(--fs-sm)]"
								>
									<input
										type="radio"
										name="hat"
										checked={picked === index}
										onChange={() => setPicked(index)}
									/>
									<span className="flex flex-col">
										<span className="font-medium text-text">{hat.role}</span>
										<span className="text-[length:var(--fs-xs)] text-text-muted">
											{hat.accountName}
										</span>
									</span>
								</label>
							))}
						</fieldset>
						{error ? (
							<p
								role="alert"
								className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[length:var(--fs-sm)] text-destructive"
							>
								{error}
							</p>
						) : null}
						<button
							type="submit"
							disabled={busy}
							className="inline-flex min-h-tap items-center justify-center rounded-md bg-accent px-4 text-[length:var(--fs-md)] font-medium text-on-accent transition-opacity disabled:opacity-50"
						>
							{busy ? "Continuing..." : "Continue"}
						</button>
					</form>
				) : (
					<p
						role="status"
						className="mt-4 text-[length:var(--fs-sm)] text-text-muted"
					>
						No active roles were found for this account.
					</p>
				)}
				<button
					type="button"
					disabled={busy}
					onClick={onSignOut}
					className="mt-4 w-full text-center text-[length:var(--fs-sm)] text-text-muted underline hover:text-text disabled:opacity-50"
				>
					Sign out and use another account
				</button>
			</div>
		</div>
	);
}
