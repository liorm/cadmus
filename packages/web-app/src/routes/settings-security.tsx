import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { SettingsSection } from "@/components/SettingsRows";
import { LoadGate } from "@/components/Skeleton";
import { useCadmus } from "@/context/CadmusContext";
import { formatRemaining, useElevation } from "@/context/ElevationContext";
import { useSession } from "@/context/SessionContext";
import { useMemberships } from "@/hooks/useMemberships";
import { useScopedResource } from "@/hooks/useScopedResource";
import { isoTime, signOut } from "@/lib/session";

interface SessionRow {
	id: string;
	accountId: string;
	current: boolean;
	loginMethod?: string;
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

const buttonClass = "min-h-tap rounded-md border border-border px-3";

function AssumeRole() {
	const session = useSession();
	const memberships = useMemberships();
	const hat = session.principal?.role;
	const accountId = session.principal?.accountId;
	const others = memberships.flatMap((membership) =>
		membership.roles
			.filter((role) => !(role === hat && membership.accountId === accountId))
			.map((role) => ({
				role,
				accountId: membership.accountId,
				label: `${role} in ${membership.name}`,
			})),
	);
	const [error, setError] = useState<string | null>(null);
	if (!session.tokens || others.length === 0) return null;
	return (
		<SettingsSection title="Sign in as a different role">
			<div className="flex flex-col gap-2 px-4 py-3">
				<p className="text-[length:var(--fs-sm)] text-text-muted">
					This starts a new sign-in. The current session ends.
				</p>
				{error ? (
					<p role="alert" className="text-destructive">
						{error}
					</p>
				) : null}
				{others.map((choice) => (
					<button
						key={`${choice.accountId}:${choice.role}`}
						type="button"
						className={buttonClass}
						onClick={() => {
							setError(null);
							void fetch("/api/auth/assumeRole", {
								method: "POST",
								credentials: "same-origin",
								headers: {
									"Content-Type": "application/json",
									Authorization: `Bearer ${session.tokens?.accessToken ?? ""}`,
									Origin: window.location.origin,
								},
								body: JSON.stringify({
									id: "assume-role",
									type: "auth.assumeRole",
									payload: {
										role: choice.role,
										accountId: choice.accountId,
									},
								}),
							}).then(async (res) => {
								if (!res.ok) {
									const body = (await res.json().catch(() => null)) as {
										error?: { code?: string };
									} | null;
									setError(
										body?.error?.code === "role_unchanged"
											? "That is already your role."
											: "Could not sign in as that role.",
									);
									return;
								}
								window.location.assign("/");
							});
						}}
					>
						{choice.label}
					</button>
				))}
			</div>
		</SettingsSection>
	);
}

/** Email first, then a name that is not just the email, then the user id. */
function signedInLabel(principal: {
	userId?: string;
	name?: string;
	email?: string;
}): string {
	const email = principal.email?.trim();
	const name = principal.name?.trim();
	if (email) return email;
	if (name) return name;
	return principal.userId ?? "Signed in";
}

function signedInDetail(principal: {
	userId?: string;
	name?: string;
	email?: string;
	role: string;
	accountId: string;
}): string {
	const role = `${principal.role} in ${principal.accountId}`;
	const email = principal.email?.trim();
	const name = principal.name?.trim();
	if (email && name && name.toLowerCase() !== email.toLowerCase()) {
		return `${name} · ${role}`;
	}
	return role;
}

function SignedOut({ providers }: { providers: string[] }) {
	const hasGoogle = providers.includes("google");
	return (
		<SettingsSection title="Sign in">
			<div className="flex flex-col gap-3 px-4 py-3">
				<p className="text-[length:var(--fs-sm)] text-text-muted">
					{hasGoogle
						? "You are using the shared access key. Sign in to act as yourself."
						: "Sign-in is not enabled on this server yet."}
				</p>
				{hasGoogle ? (
					<a
						href="/api/auth/login/google/start"
						className="inline-flex min-h-tap items-center justify-center rounded-md border border-border px-4 font-semibold"
					>
						Sign in with Google
					</a>
				) : null}
			</div>
		</SettingsSection>
	);
}

/**
 * Admin mode: a 15-minute toggle on this session that sensitive account-admin
 * and super-admin actions need. Shows the time left and a way out. The state
 * lives in ElevationProvider so the app-wide banner shows the same thing.
 */
function AdminMode() {
	const { until, now, busy, error, toggle, recheck } = useElevation();

	return (
		<SettingsSection title="Admin mode">
			<div className="flex flex-col gap-3 px-4 py-3">
				{until === "unreadable" ? (
					<p className="text-[length:var(--fs-sm)] text-text-muted">
						Could not read admin mode. It may be on or off.
					</p>
				) : until === "unknown" ? (
					<p
						role="status"
						className="text-[length:var(--fs-sm)] text-text-muted"
					>
						Checking admin mode...
					</p>
				) : until !== undefined ? (
					<p role="status" className="font-semibold">
						On, ends in {formatRemaining(until - now)}
					</p>
				) : (
					<p className="text-[length:var(--fs-sm)] text-text-muted">
						Off. Sensitive actions such as removing members or deleting bots
						need it. It lasts 15 minutes.
					</p>
				)}
				{error ? (
					<p role="alert" className="text-destructive">
						{error}
					</p>
				) : null}
				<button
					type="button"
					className={buttonClass}
					disabled={busy || until === "unknown" || until === "unreadable"}
					onClick={() => {
						void toggle(until === undefined);
					}}
				>
					{until === undefined
						? "Turn on admin mode"
						: typeof until === "number"
							? "Leave admin mode"
							: "Admin mode unavailable"}
				</button>
				{until === "unreadable" ? (
					<button type="button" className={buttonClass} onClick={recheck}>
						Check again
					</button>
				) : null}
			</div>
		</SettingsSection>
	);
}

function SignedIn() {
	const { client } = useCadmus();
	const session = useSession();
	const principal = session.principal;
	const principalPending = session.signedIn && principal === null;
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	// The bootstrap user accumulates a session per sign-in. Rendering every
	// row blocks the page long enough that admin mode's own status misses
	// the test deadline. The list stays newest-first from the server.
	const [shownSessions, setShownSessions] = useState(25);

	const loaded = useScopedResource("security", async () => {
		const [sessions, methods] = await Promise.all([
			client.callRpc<{ sessions?: SessionRow[] }>("auth.sessions.list"),
			client.callRpc<{ methods?: MethodRow[] }>("auth.methods.list"),
		]);
		if (!sessions.ok || !methods.ok) {
			throw new Error(
				sessions.error?.message ??
					methods.error?.message ??
					"Could not load sessions",
			);
		}
		return {
			sessions: sessions.result?.sessions ?? [],
			methods: methods.result?.methods ?? [],
		};
	});

	const act = async (type: string, payload: Record<string, unknown> = {}) => {
		setBusy(true);
		setError(null);
		const res = await client.callRpc(type, payload);
		setBusy(false);
		if (!res.ok) {
			setError(res.error?.message ?? "That did not work");
			return;
		}
		loaded.retry();
	};

	const sessions = loaded.data?.sessions ?? [];
	const visibleSessions = sessions.slice(0, shownSessions);
	const hiddenSessions = sessions.length - visibleSessions.length;

	return (
		<>
			<SettingsSection title="Signed in as">
				<div className="px-4 py-3">
					{principalPending || !principal ? (
						<>
							<p className="font-semibold">
								{session.tokens?.userId ?? "Loading session..."}
							</p>
							<p className="text-[length:var(--fs-sm)] text-text-muted">
								{session.tokens?.accountId
									? `Loading role in ${session.tokens.accountId}...`
									: "Loading account details..."}
							</p>
						</>
					) : (
						<>
							<p className="font-semibold">{signedInLabel(principal)}</p>
							<p className="text-[length:var(--fs-sm)] text-text-muted">
								{signedInDetail(principal)}
							</p>
						</>
					)}
					<button
						type="button"
						className={`${buttonClass} mt-3`}
						onClick={() => {
							void signOut().then((ended) => {
								if (ended) {
									window.location.assign("/");
								} else {
									setError(
										"Could not sign out. Check your connection and try again.",
									);
								}
							});
						}}
					>
						Sign out
					</button>
				</div>
			</SettingsSection>
			{!principalPending && principal?.kind === "user" ? <AssumeRole /> : null}
			{!principalPending &&
			principal?.kind === "user" &&
			(principal.role === "account-admin" ||
				principal.role === "super-admin") ? (
				<AdminMode />
			) : null}
			{error ? (
				<p role="alert" className="text-destructive">
					{error}
				</p>
			) : null}
			<LoadGate
				phase={loaded.phase}
				error={loaded.error}
				onRetry={loaded.retry}
				label="Loading sessions"
			>
				<SettingsSection title="Sessions">
					<ul className="flex flex-col">
						{visibleSessions.map((row) => (
							<li
								key={row.id}
								className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
							>
								<span className="min-w-0 flex-1">
									<span className="block font-semibold">
										{row.current
											? "This session"
											: (row.userAgent ?? "Session")}
									</span>
									<span className="block truncate text-[length:var(--fs-sm)] text-text-muted">
										{row.loginMethod ?? "token"}
										{row.ipCountry ? ` · ${row.ipCountry}` : ""} · last used{" "}
										{isoTime(row.lastUsedAt)}
									</span>
								</span>
								{row.current ? null : (
									<button
										type="button"
										className={buttonClass}
										disabled={busy}
										aria-label={`Revoke session ${row.id}`}
										onClick={() => {
											void act("auth.sessions.revoke", { sessionId: row.id });
										}}
									>
										Revoke
									</button>
								)}
							</li>
						))}
					</ul>
					{hiddenSessions > 0 ? (
						<div className="px-4 py-3">
							<button
								type="button"
								className={buttonClass}
								onClick={() => setShownSessions((count) => count + 25)}
							>
								Show more sessions
							</button>
						</div>
					) : null}
					<div className="px-4 py-3">
						<button
							type="button"
							className={buttonClass}
							disabled={busy}
							onClick={() => {
								void act("auth.sessions.revokeOthers");
							}}
						>
							Sign out other sessions
						</button>
					</div>
				</SettingsSection>
				<SettingsSection title="Login methods">
					<p className="border-b border-border px-4 py-3 text-[length:var(--fs-sm)] text-text-muted">
						Sign in with Google from the signed-out screen. Deleting a method
						does not remove your account.
					</p>
					<ul className="flex flex-col">
						{(loaded.data?.methods ?? []).map((row) => (
							<li
								key={row.id}
								className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
							>
								<span className="min-w-0 flex-1">
									<span className="block font-semibold capitalize">
										{row.provider}
									</span>
									<span className="block truncate text-[length:var(--fs-sm)] text-text-muted">
										{row.display ?? row.id}
									</span>
								</span>
								<button
									type="button"
									className={buttonClass}
									disabled={busy}
									aria-label={`Delete ${row.provider} login ${row.display ?? row.id}`}
									onClick={() => {
										void act("auth.methods.delete", { methodId: row.id });
									}}
								>
									Delete
								</button>
							</li>
						))}
					</ul>
				</SettingsSection>
			</LoadGate>
		</>
	);
}

export function SecuritySettingsPage() {
	const session = useSession();
	return (
		<AppShell title="Sign-in and sessions" backTo="/settings">
			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-4">
				{session.signedIn ? (
					<SignedIn />
				) : (
					<SignedOut providers={session.providers} />
				)}
			</div>
		</AppShell>
	);
}
