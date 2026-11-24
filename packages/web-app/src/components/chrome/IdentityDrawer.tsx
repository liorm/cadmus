import * as Dialog from "@radix-ui/react-dialog";
import { Check, LogOut, Palette, Shield, Trash2, Users, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { PersonaBadge } from "@/components/chrome/PersonaBadge";
import { useCadmus } from "@/context/CadmusContext";
import { useSession } from "@/context/SessionContext";
import { useMemberships } from "@/hooks/useMemberships";
import { isoTime, selectAccount, signOut } from "@/lib/session";
import { orderSessions } from "@/lib/session-order";
import { getTheme, setTheme, THEMES, type ThemeName } from "@/theme/theme";

interface SessionRow {
	id: string;
	accountId: string;
	current: boolean;
	loginMethod?: string;
	client?: "web" | "cli";
	userAgent?: string;
	ipCountry?: string;
	createdAt: number;
	lastUsedAt: number;
}

interface MethodRow {
	id: string;
	provider: string;
	display?: string;
	createdAt: number;
}

export function IdentityDrawer({
	open,
	onClose,
}: {
	open: boolean;
	onClose: () => void;
}) {
	const { client } = useCadmus();
	const session = useSession();
	const memberships = useMemberships();
	const principal = session.principal;

	const [theme, setThemeState] = useState<ThemeName>(() => getTheme());
	const [sessions, setSessions] = useState<SessionRow[]>([]);
	const [methods, setMethods] = useState<MethodRow[]>([]);
	const [loadingSecurity, setLoadingSecurity] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [shownSessions, setShownSessions] = useState(10);

	const loadSecurity = useCallback(async () => {
		setLoadingSecurity(true);
		setError(null);
		try {
			const [sessionsRes, methodsRes] = await Promise.all([
				client.callRpc<{ sessions?: SessionRow[] }>("auth.sessions.list"),
				client.callRpc<{ methods?: MethodRow[] }>("auth.methods.list"),
			]);
			if (!sessionsRes.ok || !methodsRes.ok) {
				setError(
					sessionsRes.error?.message ??
						methodsRes.error?.message ??
						"Could not load security details.",
				);
				return;
			}
			setSessions(orderSessions(sessionsRes.result?.sessions ?? []));
			setMethods(methodsRes.result?.methods ?? []);
		} catch (err: unknown) {
			setError(
				err instanceof Error ? err.message : "Could not load security details.",
			);
		} finally {
			setLoadingSecurity(false);
		}
	}, [client]);

	useEffect(() => {
		if (!open) return;
		void loadSecurity();
	}, [open, loadSecurity]);

	const handleAssumeRole = async (role: string, accountId: string) => {
		if (!session.tokens) return;
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/auth/assumeRole", {
				method: "POST",
				credentials: "same-origin",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${session.tokens.accessToken}`,
					Origin: window.location.origin,
				},
				body: JSON.stringify({
					id: "assume-role",
					type: "auth.assumeRole",
					payload: { role, accountId },
				}),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as {
					error?: { message?: string; code?: string };
				} | null;
				setError(
					body?.error?.message ??
						(body?.error?.code === "role_unchanged"
							? "That is already your active role."
							: "Could not switch role."),
				);
				return;
			}
			selectAccount(null);
			window.location.assign("/app");
		} catch {
			setError("Network error while switching role.");
		} finally {
			setBusy(false);
		}
	};

	const handleRevokeSession = async (sessionId: string) => {
		setBusy(true);
		setError(null);
		const res = await client.callRpc("auth.sessions.revoke", { sessionId });
		setBusy(false);
		if (!res.ok) {
			setError(res.error?.message ?? "Could not revoke session.");
			return;
		}
		await loadSecurity();
	};

	const handleRevokeOthers = async () => {
		setBusy(true);
		setError(null);
		const res = await client.callRpc("auth.sessions.revokeOthers");
		setBusy(false);
		if (!res.ok) {
			setError(res.error?.message ?? "Could not sign out other sessions.");
			return;
		}
		await loadSecurity();
	};

	const handleDeleteMethod = async (methodId: string) => {
		setBusy(true);
		setError(null);
		const res = await client.callRpc("auth.methods.delete", { methodId });
		setBusy(false);
		if (!res.ok) {
			setError(res.error?.message ?? "Could not remove login method.");
			return;
		}
		await loadSecurity();
	};

	const handleSignOut = async () => {
		setBusy(true);
		const ended = await signOut();
		setBusy(false);
		if (ended) {
			window.location.assign("/login");
		} else {
			setError("Could not sign out. Check your connection and try again.");
		}
	};

	const hat = principal?.role;
	const activeAccountId = principal?.accountId;
	const hatChoices = memberships.flatMap((membership) =>
		membership.roles.map((role) => ({
			role,
			accountId: membership.accountId,
			accountName: membership.name,
			current: role === hat && membership.accountId === activeAccountId,
			sameRoleDifferentAccount:
				role === hat && membership.accountId !== activeAccountId,
		})),
	);

	return (
		<Dialog.Root
			open={open}
			onOpenChange={(next) => {
				if (!next) onClose();
			}}
		>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px]" />
				<Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-border bg-surface shadow-2xl outline-none">
					<div className="flex items-center justify-between border-b border-border px-4 py-3">
						<div className="min-w-0">
							<Dialog.Title className="text-sm font-semibold text-text">
								Identity &amp; Security
							</Dialog.Title>
							<Dialog.Description className="truncate text-xs text-text-muted">
								{principal?.email || principal?.userId || "Signed-in session"}
							</Dialog.Description>
						</div>
						<Dialog.Close asChild>
							<button
								type="button"
								aria-label="Close identity drawer"
								className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-surface-raised hover:text-text"
							>
								<X className="h-4 w-4" />
							</button>
						</Dialog.Close>
					</div>

					<div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
						{error ? (
							<div
								role="alert"
								className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
							>
								{error}
							</div>
						) : null}

						<section className="rounded-xl border border-border bg-bg/60 p-3">
							<div className="flex items-start justify-between gap-2">
								<div className="min-w-0">
									<div className="truncate text-sm font-semibold text-text">
										{principal?.name?.trim() ||
											principal?.email?.trim() ||
											principal?.userId ||
											"Active User"}
									</div>
									{principal?.email ? (
										<div className="truncate text-xs text-text-muted">
											{principal.email}
										</div>
									) : null}
									<div className="mt-1 text-[11px] text-text-muted">
										Account:{" "}
										<span className="font-mono text-text">
											{principal?.accountId ?? "—"}
										</span>
									</div>
								</div>
								<PersonaBadge persona={principal?.role} />
							</div>
						</section>

						{hatChoices.length > 0 ? (
							<section
								aria-label="Switch role or account"
								className="space-y-2"
							>
								<div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-text-muted">
									<Users className="h-3.5 w-3.5" />
									<span>Role &amp; Account</span>
								</div>
								<div className="space-y-1.5">
									{hatChoices.map((choice) => (
										<button
											key={`${choice.accountId}:${choice.role}`}
											type="button"
											disabled={busy || choice.current}
											onClick={() => {
												if (choice.sameRoleDifferentAccount) {
													selectAccount(choice.accountId);
													window.location.reload();
												} else {
													void handleAssumeRole(choice.role, choice.accountId);
												}
											}}
											className="flex min-h-tap w-full items-center justify-between gap-2 rounded-lg border border-border bg-bg/50 px-3 py-2 text-left text-xs transition hover:border-accent/50 hover:bg-surface-raised disabled:cursor-default disabled:opacity-80"
										>
											<span className="min-w-0">
												<span className="block truncate font-semibold text-text">
													{choice.role} · {choice.accountName}
												</span>
												<span className="block truncate font-mono text-[11px] text-text-muted">
													{choice.accountId}
												</span>
											</span>
											{choice.current ? (
												<span className="inline-flex items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-semibold text-accent">
													<Check className="h-3 w-3" />
													Active
												</span>
											) : (
												<span className="text-[11px] font-medium text-accent">
													Switch
												</span>
											)}
										</button>
									))}
								</div>
							</section>
						) : null}

						<section aria-label="Appearance" className="space-y-2">
							<div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-text-muted">
								<Palette className="h-3.5 w-3.5" />
								<span>Theme</span>
							</div>
							<div className="grid grid-cols-3 gap-2">
								{THEMES.map((option) => (
									<button
										key={option}
										type="button"
										onClick={() => {
											setTheme(option);
											setThemeState(option);
										}}
										className={
											theme === option
												? "min-h-tap rounded-lg border border-accent bg-accent/15 px-2.5 text-xs font-semibold capitalize text-accent"
												: "min-h-tap rounded-lg border border-border bg-bg/50 px-2.5 text-xs font-medium capitalize text-text-muted hover:text-text"
										}
									>
										{option}
									</button>
								))}
							</div>
						</section>

						<section aria-label="Active sessions" className="space-y-2">
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-text-muted">
									<Shield className="h-3.5 w-3.5" />
									<span>Sessions ({sessions.length})</span>
								</div>
								{sessions.some((s) => !s.current) ? (
									<button
										type="button"
										disabled={busy}
										onClick={() => void handleRevokeOthers()}
										className="text-[11px] font-medium text-accent hover:underline disabled:opacity-50"
									>
										Sign out others
									</button>
								) : null}
							</div>
							{loadingSecurity ? (
								<p className="text-xs text-text-muted">Loading sessions…</p>
							) : sessions.length === 0 ? (
								<p className="text-xs text-text-muted">No active sessions.</p>
							) : (
								<ul className="space-y-1.5">
									{sessions.slice(0, shownSessions).map((row) => (
										<li
											key={row.id}
											className="flex items-center justify-between gap-2 rounded-lg border border-border bg-bg/50 px-3 py-2 text-xs"
										>
											<div className="min-w-0 flex-1">
												<div className="truncate font-medium text-text">
													{row.userAgent ||
														(row.client === "cli"
															? "Cadmus CLI"
															: "Web session")}
												</div>
												<div className="truncate text-[11px] text-text-muted">
													{row.current ? "This session · " : ""}
													{row.client === "cli"
														? "CLI"
														: (row.loginMethod ?? "web")}
													{row.ipCountry ? ` · ${row.ipCountry}` : ""} ·{" "}
													{isoTime(row.lastUsedAt)}
												</div>
											</div>
											{!row.current ? (
												<button
													type="button"
													disabled={busy}
													onClick={() => void handleRevokeSession(row.id)}
													className="rounded border border-border px-2 py-1 text-[11px] text-text-muted hover:border-destructive/50 hover:text-destructive disabled:opacity-50"
												>
													Revoke
												</button>
											) : null}
										</li>
									))}
								</ul>
							)}
							{sessions.length > shownSessions ? (
								<button
									type="button"
									onClick={() => setShownSessions((n) => n + 15)}
									className="text-xs font-medium text-accent hover:underline"
								>
									Show more sessions ({sessions.length - shownSessions} hidden)
								</button>
							) : null}
						</section>

						{methods.length > 0 ? (
							<section aria-label="Login methods" className="space-y-2">
								<div className="text-xs font-semibold uppercase tracking-wide text-text-muted">
									Login methods
								</div>
								<ul className="space-y-1.5">
									{methods.map((method) => (
										<li
											key={method.id}
											className="flex items-center justify-between gap-2 rounded-lg border border-border bg-bg/50 px-3 py-2 text-xs"
										>
											<div className="min-w-0">
												<div className="font-medium capitalize text-text">
													{method.provider}
												</div>
												<div className="truncate text-[11px] text-text-muted">
													{method.display ?? method.id}
												</div>
											</div>
											<button
												type="button"
												disabled={busy || methods.length <= 1}
												onClick={() => void handleDeleteMethod(method.id)}
												aria-label={`Delete ${method.provider} login method`}
												className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-text-muted hover:border-destructive/50 hover:text-destructive disabled:opacity-40"
											>
												<Trash2 className="h-3 w-3" />
												Remove
											</button>
										</li>
									))}
								</ul>
							</section>
						) : null}
					</div>

					<div className="border-t border-border p-4">
						<button
							type="button"
							disabled={busy}
							onClick={() => void handleSignOut()}
							className="inline-flex min-h-tap w-full items-center justify-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 text-xs font-semibold text-destructive hover:bg-destructive/15 disabled:opacity-50"
						>
							<LogOut className="h-3.5 w-3.5" />
							Sign out
						</button>
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
