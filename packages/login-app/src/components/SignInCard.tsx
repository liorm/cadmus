import { useState } from "react";
import { rememberDeviceCode } from "@/lib/device-login";
import { buildGoogleStartUrl } from "@/lib/login-flow";
import { clearSelectedAccount } from "@/lib/session";

export interface DevLoginSuccess {
	accessToken: string;
	expiresAt: number;
	provisional: boolean;
}

export function SignInCard({
	providers,
	deviceCode,
	next,
	authError,
	onDevLoginSuccess,
}: {
	providers: string[];
	deviceCode: string | null;
	next: string;
	authError: string | null;
	onDevLoginSuccess: (result: DevLoginSuccess) => void;
}) {
	const google = providers.includes("google");
	const devPassword = providers.includes("dev-password");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [chooseRole, setChooseRole] = useState(false);
	const [error, setError] = useState<string | null>(authError);
	const [busy, setBusy] = useState(false);

	const googleStartUrl = buildGoogleStartUrl({
		chooseRole,
		deviceCode,
		next,
	});

	const submitDev = async () => {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/auth/login/devPassword", {
				method: "POST",
				credentials: "same-origin",
				headers: {
					"Content-Type": "application/json",
					Origin: window.location.origin,
				},
				body: JSON.stringify({
					id: "dev-password",
					type: "auth.login.devPassword",
					payload: {
						password,
						...(email.trim() ? { email: email.trim() } : {}),
						...(chooseRole ? { chooseRole: true } : {}),
					},
				}),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as {
					error?: { message?: string };
				} | null;
				setError(body?.error?.message ?? "Login refused");
				setBusy(false);
				return;
			}
			const body = (await res.json().catch(() => null)) as {
				accessToken?: string;
				expiresAt?: number;
				provisional?: boolean;
			} | null;
			clearSelectedAccount();
			if (body?.accessToken && typeof body.expiresAt === "number") {
				onDevLoginSuccess({
					accessToken: body.accessToken,
					expiresAt: body.expiresAt,
					provisional: body.provisional === true,
				});
				return;
			}
			window.location.assign(deviceCode ? "/login/device" : next);
		} catch {
			setError("Could not reach the server");
			setBusy(false);
		}
	};

	const hasAnyProvider = google || devPassword;

	return (
		<div className="flex min-h-dvh items-center justify-center bg-bg p-6">
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby="login-title"
				className="w-full max-w-sm rounded-lg border border-border bg-surface p-6 shadow-lg"
			>
				<h1
					id="login-title"
					className="text-[length:var(--fs-lg)] font-semibold"
				>
					Sign in to Cadmus
				</h1>
				<p className="mt-2 text-[length:var(--fs-sm)] text-text-muted">
					{deviceCode
						? "Sign in to approve your CLI device login."
						: "Authenticate to continue to Cadmus."}
				</p>
				{deviceCode ? (
					<div className="mt-4 rounded-md border border-border bg-surface-raised px-3 py-2">
						<p className="text-[length:var(--fs-xs)] text-text-muted">
							Device code
						</p>
						<p className="mt-0.5 font-mono text-[length:var(--fs-md)] tracking-widest">
							{deviceCode}
						</p>
					</div>
				) : null}
				{error ? (
					<p
						role="alert"
						className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[length:var(--fs-sm)] text-destructive"
					>
						{error}
					</p>
				) : null}
				<div className="mt-5 flex flex-col gap-4">
					{hasAnyProvider ? (
						<label className="flex cursor-pointer items-center gap-2 text-[length:var(--fs-sm)] text-text-muted">
							<input
								type="checkbox"
								checked={chooseRole}
								onChange={(event) => setChooseRole(event.target.checked)}
							/>
							Choose a role after sign-in
						</label>
					) : null}
					{google ? (
						<a
							href={googleStartUrl}
							onClick={() => {
								clearSelectedAccount();
								if (deviceCode) rememberDeviceCode(deviceCode);
							}}
							className="inline-flex min-h-tap items-center justify-center rounded-md bg-accent px-4 text-[length:var(--fs-md)] font-semibold text-on-accent transition-opacity hover:opacity-90"
						>
							Sign in with Google
						</a>
					) : null}
					{devPassword ? (
						<form
							className="flex flex-col gap-3"
							onSubmit={(event) => {
								event.preventDefault();
								void submitDev();
							}}
						>
							<p className="text-[length:var(--fs-sm)] text-text-muted">
								{google
									? "Or use the local development password."
									: "Local development password."}
							</p>
							<label className="flex flex-col gap-1 text-[length:var(--fs-sm)]">
								Email
								<input
									type="email"
									autoComplete="username"
									value={email}
									onChange={(event) => setEmail(event.target.value)}
									placeholder="Bootstrap email if left blank"
									className="min-h-tap rounded-md border border-border bg-bg px-3 text-[length:var(--fs-md)] text-text"
								/>
							</label>
							<label className="flex flex-col gap-1 text-[length:var(--fs-sm)]">
								Password
								<input
									type="password"
									autoComplete="current-password"
									required
									value={password}
									onChange={(event) => setPassword(event.target.value)}
									className="min-h-tap rounded-md border border-border bg-bg px-3 text-[length:var(--fs-md)] text-text"
								/>
							</label>
							<button
								type="submit"
								disabled={busy || password.length === 0}
								className="inline-flex min-h-tap items-center justify-center rounded-md bg-accent px-4 text-[length:var(--fs-md)] font-medium text-on-accent transition-opacity disabled:opacity-50"
							>
								{busy ? "Signing in..." : "Sign in"}
							</button>
						</form>
					) : null}
					{!hasAnyProvider ? (
						<p
							role="status"
							className="text-[length:var(--fs-sm)] text-text-muted"
						>
							Sign-in is not enabled on this server.
						</p>
					) : null}
				</div>
			</div>
		</div>
	);
}
