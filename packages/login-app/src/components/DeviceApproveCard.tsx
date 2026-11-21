import { useState } from "react";
import { clearDeviceCode } from "@/lib/device-login";
import type { SessionPrincipal } from "@/lib/session";

/**
 * Confirms a CLI device code after a finished session exists. The page never
 * shows tokens. Closing the tab is best-effort.
 */
export function DeviceApproveCard({
	code,
	accessToken,
	principal,
}: {
	code: string;
	accessToken: string;
	principal: SessionPrincipal | null;
}) {
	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState<"approved" | "denied" | null>(null);
	const [busy, setBusy] = useState(false);

	const decide = (decision: "approve" | "deny") => {
		setBusy(true);
		setError(null);
		const path =
			decision === "approve"
				? "/api/auth/login/device/approve"
				: "/api/auth/login/device/deny";
		void fetch(path, {
			method: "POST",
			credentials: "same-origin",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${accessToken}`,
				Origin: window.location.origin,
			},
			body: JSON.stringify({
				id: `device-${decision}`,
				type: `auth.login.device.${decision}`,
				payload: { deviceCode: code },
			}),
		})
			.then(async (res) => {
				if (!res.ok) {
					const body = (await res.json().catch(() => null)) as {
						error?: { message?: string };
					} | null;
					setError(body?.error?.message ?? "Device login refused");
					setBusy(false);
					return;
				}
				clearDeviceCode();
				setDone(decision === "approve" ? "approved" : "denied");
				setBusy(false);
				window.close();
			})
			.catch(() => {
				setError("Could not reach the server");
				setBusy(false);
			});
	};

	return (
		<div className="flex min-h-dvh items-center justify-center bg-bg p-6">
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby="device-title"
				className="w-full max-w-sm rounded-lg border border-border bg-surface p-6 shadow-lg"
			>
				<h1
					id="device-title"
					className="text-[length:var(--fs-lg)] font-semibold"
				>
					Approve device login
				</h1>
				<p className="mt-2 text-[length:var(--fs-sm)] text-text-muted">
					Confirm this code matches the one in your terminal.
				</p>
				<p className="mt-4 rounded-md border border-border bg-surface-raised px-3 py-2 text-center font-mono text-[length:var(--fs-lg)] tracking-widest">
					{code}
				</p>
				{principal ? (
					<p className="mt-3 text-[length:var(--fs-xs)] text-text-muted">
						Acting as{" "}
						<span className="text-text">
							{principal.email ?? principal.name ?? principal.userId}
						</span>{" "}
						({principal.role} in {principal.accountId})
					</p>
				) : null}
				{done ? (
					<div className="mt-4 flex flex-col gap-3">
						<p role="status" className="text-[length:var(--fs-sm)]">
							{done === "approved"
								? "Approved. You can close this tab."
								: "Denied. You can close this tab."}
						</p>
						<a
							href="/app"
							className="text-[length:var(--fs-sm)] text-accent underline"
						>
							Open Cadmus
						</a>
					</div>
				) : (
					<div className="mt-5 flex gap-3">
						<button
							type="button"
							disabled={busy}
							onClick={() => decide("approve")}
							className="inline-flex min-h-tap flex-1 items-center justify-center rounded-md bg-accent px-4 text-[length:var(--fs-md)] font-medium text-on-accent transition-opacity disabled:opacity-50"
						>
							{busy ? "Working..." : "Approve"}
						</button>
						<button
							type="button"
							disabled={busy}
							onClick={() => decide("deny")}
							className="inline-flex min-h-tap flex-1 items-center justify-center rounded-md border border-border bg-transparent px-4 text-[length:var(--fs-md)] font-medium text-text transition-opacity disabled:opacity-50"
						>
							Deny
						</button>
					</div>
				)}
				{error ? (
					<p
						role="alert"
						className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[length:var(--fs-sm)] text-destructive"
					>
						{error}
					</p>
				) : null}
			</div>
		</div>
	);
}
