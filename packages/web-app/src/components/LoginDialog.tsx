import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Blocks the app until a real session exists. Google is a full navigation.
 * Dev password is offered only when the server lists it, which it refuses
 * outside local development.
 */
export function LoginDialog({ providers }: { providers: string[] }) {
	const google = providers.includes("google");
	const devPassword = providers.includes("dev-password");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

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
			window.location.assign("/");
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
				aria-labelledby="login-title"
				className="w-full max-w-sm rounded-lg border border-border bg-surface p-6 shadow-lg"
			>
				<h1 id="login-title" className="text-lg font-semibold">
					Sign in to Cadmus
				</h1>
				<p className="mt-2 text-[length:var(--fs-sm)] text-text-muted">
					The app stays closed until you sign in.
				</p>
				<div className="mt-5 flex flex-col gap-4">
					{google ? (
						<a
							href="/api/auth/login/google/start"
							className="inline-flex min-h-tap items-center justify-center rounded-md bg-accent px-4 font-semibold text-on-accent"
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
							{google ? (
								<p className="text-[length:var(--fs-sm)] text-text-muted">
									Or use the local development password.
								</p>
							) : (
								<p className="text-[length:var(--fs-sm)] text-text-muted">
									Local development password.
								</p>
							)}
							<label className="flex flex-col gap-1 text-[length:var(--fs-sm)]">
								Email
								<input
									type="email"
									autoComplete="username"
									value={email}
									onChange={(event) => setEmail(event.target.value)}
									placeholder="Bootstrap email if left blank"
									className="min-h-tap rounded-md border border-border bg-bg px-3"
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
									className="min-h-tap rounded-md border border-border bg-bg px-3"
								/>
							</label>
							{error ? (
								<p role="alert" className="text-destructive">
									{error}
								</p>
							) : null}
							<Button type="submit" disabled={busy || password.length === 0}>
								{busy ? "Signing in..." : "Sign in"}
							</Button>
						</form>
					) : null}
					{!google && !devPassword ? (
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
