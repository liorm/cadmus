import { useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { SettingsSection } from "@/components/SettingsRows";
import { LoadGate } from "@/components/Skeleton";
import { useCadmus } from "@/context/CadmusContext";
import { formatRemaining, useElevation } from "@/context/ElevationContext";
import { useSession } from "@/context/SessionContext";
import { useScopedResource } from "@/hooks/useScopedResource";
import { passkeysSupported, runPasskeyCeremony } from "@/lib/passkeys";
import {
	currentAccessToken,
	fetchPrincipal,
	isoTime,
	signOut,
} from "@/lib/session";

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
						href="/auth/login/google"
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
	const [needFresh, setNeedFresh] = useState(false);
	const [needAdminMode, setNeedAdminMode] = useState(false);
	const [needWait, setNeedWait] = useState(false);
	// The worker allows 5 unfinished prompts per purpose in 120 s, then refuses
	// without saying why. Count the page's own starts to explain that case.
	const starts = useRef<Record<string, number[]>>({});
	const { refresh: refreshAdminMode } = useElevation();
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

	const passkey = async (purpose: "register" | "remove", methodId?: string) => {
		setBusy(true);
		setError(null);
		const recent = (starts.current[purpose] ?? []).filter(
			(t) => Date.now() - t < 120_000,
		);
		recent.push(Date.now());
		starts.current[purpose] = recent;
		const done = await runPasskeyCeremony(client, purpose, methodId);
		setBusy(false);
		if (!done.ok) {
			setError(done.message);
			if (done.uncertain) {
				// The server may have committed before the reply was lost: read the
				// list and admin mode again instead of trusting the stale page.
				setNeedFresh(false);
				setNeedAdminMode(false);
				setNeedWait(false);
				void refreshAdminMode();
				loaded.retry();
				return;
			}
			// A first passkey needs a Google sign-in from the last few minutes.
			const hasPasskey = (loaded.data?.methods ?? []).some(
				(m) => m.provider === "passkey",
			);
			// Guidance only for a server refusal; a browser-side failure is not
			// evidence that the server wanted a fresh sign-in or admin mode.
			const refused = done.stage === "server";
			setNeedWait(refused && recent.length > 5);
			setNeedFresh(purpose === "register" && !hasPasskey && refused);
			setNeedAdminMode(purpose === "register" && hasPasskey && refused);
			return;
		}
		setNeedFresh(false);
		setNeedAdminMode(false);
		setNeedWait(false);
		starts.current[purpose] = [];
		if (purpose === "remove") {
			// Removing the passkey this session signed in with ends this session.
			const held = currentAccessToken();
			const still = held ? await fetchPrincipal(held.accessToken) : null;
			if (!still) {
				window.location.assign("/");
				return;
			}
		}
		// Removing the last passkey ends admin mode on the server; read it again.
		void refreshAdminMode();
		loaded.retry();
	};

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
							<p className="font-semibold">{principal.userId}</p>
							<p className="text-[length:var(--fs-sm)] text-text-muted">
								{principal.role} in {principal.accountId}
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
			{!principalPending &&
			principal?.kind === "user" &&
			!principal.viaToken &&
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
					<div className="flex flex-col gap-2 border-b border-border px-4 py-3">
						<button
							type="button"
							className={buttonClass}
							disabled={busy || !passkeysSupported()}
							onClick={() => {
								void passkey("register");
							}}
						>
							Add a passkey
						</button>
						{passkeysSupported() &&
						(needFresh ||
							!(loaded.data?.methods ?? []).some(
								(m) => m.provider === "passkey",
							)) ? (
							<p className="text-[length:var(--fs-sm)] text-text-muted">
								Adding your first passkey needs a recent Google sign-in.{" "}
								<a
									href="/auth/login/google?fresh=1"
									className="font-semibold underline"
								>
									Sign in with Google again
								</a>
								, then come back here.
							</p>
						) : null}
						{needWait ? (
							<p className="text-[length:var(--fs-sm)] text-text-muted">
								You started several passkey prompts in the last two minutes.
								Wait about two minutes, then try again.
							</p>
						) : null}
						{needAdminMode ? (
							<p className="text-[length:var(--fs-sm)] text-text-muted">
								Adding another passkey needs admin mode. Turn it on above with
								your passkey, then add the passkey again.
							</p>
						) : null}
						{passkeysSupported() ? null : (
							<p className="text-[length:var(--fs-sm)] text-text-muted">
								This browser cannot use passkeys.
							</p>
						)}
					</div>
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
									aria-label={
										row.provider === "passkey"
											? `Remove passkey ${row.display ?? row.id}`
											: `Revoke ${row.provider} login ${row.display ?? row.id}`
									}
									onClick={() => {
										// A passkey is removed only with proof of a passkey.
										if (row.provider === "passkey") {
											void passkey("remove", row.id);
										} else {
											void act("auth.methods.revoke", { methodId: row.id });
										}
									}}
								>
									{row.provider === "passkey" ? "Remove" : "Revoke"}
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
