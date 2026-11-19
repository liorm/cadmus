import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { SessionMembership } from "@/lib/session";

const RANK = ["user", "account-admin", "super-admin"];

interface HatChoice {
	role: string;
	accountId: string;
	label: string;
}

function hatChoices(memberships: SessionMembership[]): HatChoice[] {
	const choices: HatChoice[] = [];
	for (const membership of memberships) {
		for (const role of membership.roles) {
			choices.push({
				role,
				accountId: membership.accountId,
				label: `${role} in ${membership.name}`,
			});
		}
	}
	return choices.sort(
		(a, b) =>
			RANK.indexOf(a.role) - RANK.indexOf(b.role) ||
			a.label.localeCompare(b.label),
	);
}

/**
 * Blocks the app until a full session exists. Google is a full navigation.
 * Dev password is offered only when the server lists it. Role radios appear
 * only after a provisional session exists.
 */
export function LoginDialog({
	providers,
	accessToken,
	memberships = [],
}: {
	providers: string[];
	accessToken?: string;
	memberships?: SessionMembership[];
}) {
	const google = providers.includes("google");
	const devPassword = providers.includes("dev-password");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [chooseRole, setChooseRole] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const hats = accessToken ? hatChoices(memberships) : [];
	const [picked, setPicked] = useState(0);

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
				provisional?: boolean;
			} | null;
			if (body?.provisional) {
				window.location.assign("/");
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
							<label className="flex items-center gap-2 text-[length:var(--fs-sm)]">
								<input
									type="checkbox"
									checked={chooseRole}
									onChange={(event) => setChooseRole(event.target.checked)}
								/>
								Choose a role
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
					{hats.length > 0 && accessToken ? (
						<form
							className="flex flex-col gap-3"
							onSubmit={(event) => {
								event.preventDefault();
								const hat = hats[picked] ?? hats[0];
								if (!hat) return;
								setBusy(true);
								setError(null);
								void fetch("/api/auth/assumeRole", {
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
								})
									.then(async (res) => {
										if (!res.ok) {
											const failed = (await res.json().catch(() => null)) as {
												error?: { code?: string; message?: string };
											} | null;
											setError(
												failed?.error?.code === "role_unchanged"
													? "That is already your role."
													: (failed?.error?.message ?? "Could not change role"),
											);
											setBusy(false);
											return;
										}
										window.location.assign("/");
									})
									.catch(() => {
										setError("Could not reach the server");
										setBusy(false);
									});
							}}
						>
							<fieldset className="flex flex-col gap-2">
								<legend className="text-[length:var(--fs-sm)]">Role</legend>
								{hats.map((hat, index) => (
									<label
										key={`${hat.accountId}:${hat.role}`}
										className="flex items-center gap-2 text-[length:var(--fs-sm)]"
									>
										<input
											type="radio"
											name="hat"
											checked={picked === index}
											onChange={() => setPicked(index)}
										/>
										{hat.label}
									</label>
								))}
							</fieldset>
							{error ? (
								<p role="alert" className="text-destructive">
									{error}
								</p>
							) : null}
							<Button type="submit" disabled={busy}>
								{busy ? "Continuing..." : "Continue"}
							</Button>
						</form>
					) : null}
					{!google && !devPassword && hats.length === 0 ? (
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
