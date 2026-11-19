import { useState } from "react";
import { Button } from "@/components/ui/button";
import { clearDeviceCode } from "@/lib/device-login";

/**
 * Confirms a CLI device code after a finished session exists. The page does
 * not show tokens. Closing the tab is best-effort.
 */
export function DeviceApprove({
	code,
	accessToken,
}: {
	code: string;
	accessToken: string;
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
				<h1 id="device-title" className="text-lg font-semibold">
					Approve device login
				</h1>
				<p className="mt-2 text-[length:var(--fs-sm)] text-text-muted">
					Confirm this code matches the one in your terminal.
				</p>
				<p className="mt-4 font-mono text-lg tracking-widest">{code}</p>
				{done ? (
					<p role="status" className="mt-4 text-[length:var(--fs-sm)]">
						{done === "approved"
							? "Approved. You can close this tab."
							: "Denied. You can close this tab."}
					</p>
				) : (
					<div className="mt-5 flex gap-3">
						<Button
							type="button"
							disabled={busy}
							onClick={() => decide("approve")}
						>
							{busy ? "Working..." : "Approve"}
						</Button>
						<Button
							type="button"
							variant="outlined"
							disabled={busy}
							onClick={() => decide("deny")}
						>
							Deny
						</Button>
					</div>
				)}
				{error ? (
					<p role="alert" className="mt-3 text-destructive">
						{error}
					</p>
				) : null}
			</div>
		</div>
	);
}
