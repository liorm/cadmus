import type {
	AccountMember,
	ServerEvent,
	ToolsEnvRecord,
} from "@cadmus/contract/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { ElevationHelp } from "@/components/ElevationHelp";
import { fieldClass } from "@/components/SettingsRows";
import { LoadGate } from "@/components/Skeleton";
import { useCadmus } from "@/context/CadmusContext";
import { useSession } from "@/context/SessionContext";
import type { LoadPhase } from "@/lib/load-state";

function connectionLabel(env: ToolsEnvRecord): string {
	if (env.kind === "just-bash") return "connected · Sandboxed";
	const status = env.connection?.status ?? "disconnected";
	const workspace = env.connection?.workspacePath
		? ` · ${env.connection.workspacePath}`
		: "";
	const confinement =
		status === "connected" && env.connection?.confined !== undefined
			? env.connection.confined
				? " · Sandboxed"
				: " · Unconfined"
			: "";
	const error = env.connection?.lastError
		? ` · ${env.connection.lastError}`
		: "";
	return `${status}${workspace}${confinement}${error}`;
}

// Codes the server returns before any state is written: the authorization
// check and payload validation run before the handler, and a pair lookup of an
// unknown env returns before a pairing is minted. Any other failed answer
// (command_failed, internal errors, unknown codes) may follow a partial write.
const PAIR_AGAIN =
	"A new pairing command may have been issued but was not received. Any command shown earlier may no longer work. Pair again for a new command.";
const CREATE_PAIR_LOST =
	"If the env was created, its pairing command was not received: use Pair on it for a new one.";
const REFUSAL_CODES = new Set([
	"unauthorized",
	"forbidden",
	"elevation_required",
	"invalid_command",
	"invalid_json",
	"invalid_frame",
	"frame_too_large",
]);
function isRefusal(code: string | undefined, extra?: string): boolean {
	return code !== undefined && (REFUSAL_CODES.has(code) || code === extra);
}

export function ToolsSettingsPage() {
	const { client, connectionStatus, subscribeEvents } = useCadmus();
	const [envs, setEnvs] = useState<ToolsEnvRecord[]>([]);
	const [defaultEnvId, setDefaultEnvId] = useState("");
	const [canDeregister, setCanDeregister] = useState(false);
	const [labels, setLabels] = useState<Record<string, string>>({});
	const [jbLabel, setJbLabel] = useState("");
	const [jbPersist, setJbPersist] = useState(true);
	const [jbShared, setJbShared] = useState(false);
	const [daemonLabel, setDaemonLabel] = useState("");
	const [daemonPersist, setDaemonPersist] = useState(true);
	const [daemonConfinementPolicy, setDaemonConfinementPolicy] = useState<
		"required" | "preferred" | "disabled"
	>("required");
	const [pairing, setPairing] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	// The recovery warning a Pair attempt set, so a later successful Pair can
	// clear exactly that message and nothing else on the page.
	const pairErrorRef = useRef<string | null>(null);
	const setPairError = useCallback((message: string) => {
		pairErrorRef.current = message;
		setError(message);
	}, []);
	const clearPairError = useCallback(() => {
		const own = pairErrorRef.current;
		pairErrorRef.current = null;
		if (own !== null) setError((current) => (current === own ? null : current));
	}, []);
	// A lost daemon-create may have made an env whose pairing command never
	// arrived. A list read, a Pair on another env or another create cannot
	// recover it and we do not know which env it is, so the guidance is its own
	// state: it survives every read, Retry and later error until dismissed.
	const [createLost, setCreateLost] = useState(false);
	// The "Reloading the list" warning an unanswered mutation set. A successful
	// list read (immediate reload or first-load/Retry) clears exactly that
	// message or the exact failed-read text built from the same note, never
	// another error on the page.
	const recoveryRef = useRef<string | null>(null);
	const failedReadRef = useRef<string | null>(null);
	const setRecoveryError = useCallback((note: string) => {
		const message = `${note} Reloading the list; check it before trying again.`;
		recoveryRef.current = message;
		failedReadRef.current = null;
		setError(message);
	}, []);
	// Call only after a successful list read.
	const clearRecoveryError = useCallback(() => {
		const own = recoveryRef.current;
		const failed = failedReadRef.current;
		recoveryRef.current = null;
		failedReadRef.current = null;
		if (own === null) return;
		setError((current) =>
			current !== null && (current === own || current === failed)
				? null
				: current,
		);
	}, []);
	const [busy, setBusy] = useState(false);
	const [needsAdmin, setNeedsAdmin] = useState(false);
	// A mutation whose answer never arrived stays uncertain until a list read
	// succeeds, through every failed or held Retry.
	const [uncertain, setUncertainState] = useState<string | null>(null);
	const uncertainRef = useRef<string | null>(null);
	const setUncertain = useCallback((note: string | null) => {
		uncertainRef.current = note;
		setUncertainState(note);
	}, []);
	const readFailure = useCallback((reason: string) => {
		if (!uncertainRef.current) return reason;
		const text = `${uncertainRef.current} The list could not be reloaded (${reason}), so what you see may be out of date.`;
		failedReadRef.current = text;
		return text;
	}, []);
	// Callers whose role cannot hold the grants do not get the controls.
	// Create, pair, update, delete and deregister need toolsEnv.manage; the
	// default env change is account.update and needs account.manage. Both are
	// account-admin grants. whoami does not report a token's persisted grants,
	// so a token session with an account-admin role keeps the controls and the
	// worker's answer decides (decision 13 allows elevated tokens). Signed out
	// is not an admin.
	const session = useSession();
	const principal = session.principal;
	const principalPending = session.signedIn && principal === null;
	const canManage =
		session.signedIn &&
		principal !== null &&
		principal.role === "account-admin";
	const [phase, setPhase] = useState<LoadPhase>("loading");
	const [attempt, setAttempt] = useState(0);

	// Foreground reads (first load, Retry, post-mutation reread) are trusted
	// reads and publish everything. Background reads (live status poll) must
	// not clobber drafts, race a mutation, or publish an older snapshot, so
	// each carries a generation and is dropped if a mutation or foreground
	// read started after it did.
	const genRef = useRef(0);
	const busyRef = useRef(false);
	const phaseRef = useRef<LoadPhase>("loading");
	phaseRef.current = phase;
	const refreshingRef = useRef(false);
	const serverDefaultRef = useRef("");
	const serverLabelsRef = useRef<Record<string, string>>({});
	const [liveStale, setLiveStale] = useState<string | null>(null);
	const beginBusy = useCallback(() => {
		busyRef.current = true;
		genRef.current += 1;
		setBusy(true);
	}, []);
	const endBusy = useCallback(() => {
		busyRef.current = false;
		setBusy(false);
	}, []);

	// Reads both lists and publishes nothing. A failure of either response
	// throws before any state changes, so a partial snapshot never shows.
	const fetchSnapshot = useCallback(async () => {
		const [listed, members] = await Promise.all([
			client.callRpc<{
				envs?: ToolsEnvRecord[];
				default?: { envId?: string } | null;
			}>("account.toolsEnvs.list"),
			client.callRpc<{ members?: AccountMember[] }>("account.members.list"),
		]);
		if (!listed.ok || !members.ok) {
			throw new Error(
				listed.error?.message ??
					members.error?.message ??
					"Could not load tools environments",
			);
		}
		const me = members.result?.members?.find(
			(member) => member.userId === client.getUserId(),
		);
		return {
			envs: listed.result?.envs ?? [],
			defaultId: listed.result?.default?.envId ?? "",
			canDeregister:
				me?.roles.includes("account-admin") ||
				me?.roles.includes("super-admin") ||
				false,
		};
	}, [client]);

	// Returns false when a newer mutation or foreground read started while this
	// one was in flight (whether it succeeded or failed); the newer one owns the
	// page, so nothing is published and no error is raised.
	const load = useCallback(async (): Promise<boolean> => {
		const gen = ++genRef.current;
		let snap: Awaited<ReturnType<typeof fetchSnapshot>>;
		try {
			snap = await fetchSnapshot();
		} catch (err: unknown) {
			// An older read that fails after a newer one started does not get to
			// lock the page or write an error over the newer state.
			if (genRef.current !== gen) return false;
			throw err;
		}
		if (genRef.current !== gen) return false;
		const labelsNext = Object.fromEntries(
			snap.envs.map((env) => [env.envId, env.label ?? ""]),
		);
		serverDefaultRef.current = snap.defaultId;
		serverLabelsRef.current = labelsNext;
		setEnvs(snap.envs);
		setDefaultEnvId(snap.defaultId);
		setLabels(labelsNext);
		setCanDeregister(snap.canDeregister);
		setLiveStale(null);
		return true;
	}, [fetchSnapshot]);

	// Live status refresh: one at a time, only while ready and idle, merged
	// into the page without touching unsaved edits. A failure is shown, not
	// swallowed, but does not lock the page or drop drafts.
	const refresh = useCallback(async () => {
		if (
			refreshingRef.current ||
			busyRef.current ||
			phaseRef.current !== "ready" ||
			uncertainRef.current
		)
			return;
		refreshingRef.current = true;
		const gen = genRef.current;
		try {
			const snap = await fetchSnapshot();
			if (
				genRef.current !== gen ||
				busyRef.current ||
				phaseRef.current !== "ready" ||
				uncertainRef.current
			)
				return;
			const prevLabels = serverLabelsRef.current;
			const nextServerLabels = Object.fromEntries(
				snap.envs.map((env) => [env.envId, env.label ?? ""]),
			);
			setLabels((draft) =>
				Object.fromEntries(
					snap.envs.map((env) => {
						const server = nextServerLabels[env.envId] ?? "";
						const edited =
							env.envId in prevLabels &&
							draft[env.envId] !== undefined &&
							draft[env.envId] !== prevLabels[env.envId];
						return [env.envId, edited ? (draft[env.envId] ?? server) : server];
					}),
				),
			);
			const prevDefault = serverDefaultRef.current;
			setDefaultEnvId((draft) =>
				draft === prevDefault ? snap.defaultId : draft,
			);
			serverLabelsRef.current = nextServerLabels;
			serverDefaultRef.current = snap.defaultId;
			setEnvs(snap.envs);
			setCanDeregister(snap.canDeregister);
			setLiveStale(null);
		} catch (err: unknown) {
			if (genRef.current !== gen || phaseRef.current !== "ready") return;
			setLiveStale(
				`Live status could not be refreshed (${err instanceof Error ? err.message : "network error"}), so what you see may be out of date. Changes are off until the next refresh succeeds; your edits are kept.`,
			);
		} finally {
			refreshingRef.current = false;
		}
	}, [fetchSnapshot]);

	// After a mutation, re-read the list. A failed re-read leaves the list stale,
	// so it locks the page into the error phase (Retry recovers) instead of
	// leaving ready-looking actions active over data we no longer trust.
	const reload = useCallback(
		async (note?: string) => {
			if (note) setUncertain(note);
			try {
				if (await load()) {
					setUncertain(null);
					clearRecoveryError();
				}
			} catch (err: unknown) {
				setPhase("error");
				setError(
					readFailure(
						err instanceof Error
							? err.message
							: "Could not load tools environments",
					),
				);
			}
		},
		[load, setUncertain, readFailure, clearRecoveryError],
	);

	useEffect(() => {
		let cancelled = false;
		void attempt;
		setPhase("loading");
		setError(null);
		void load()
			.then((published) => {
				if (cancelled || !published) return;
				setUncertain(null);
				clearRecoveryError();
				setPhase("ready");
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setPhase("error");
				setError(
					readFailure(
						err instanceof Error
							? err.message
							: "Could not load tools environments",
					),
				);
			});
		return () => {
			cancelled = true;
		};
	}, [attempt, load, setUncertain, readFailure, clearRecoveryError]);

	useEffect(() => {
		return subscribeEvents((event: ServerEvent) => {
			if (event.type !== "account.toolsEnv.event") return;
			const payload = event.payload;
			setEnvs((prev) => {
				let matched = false;
				const next = prev.map((env) => {
					if (env.envId !== payload.envId) return env;
					matched = true;
					return {
						...env,
						connection: {
							status: payload.status,
							...(payload.connectedAt !== undefined
								? { connectedAt: payload.connectedAt }
								: env.connection?.connectedAt !== undefined
									? { connectedAt: env.connection.connectedAt }
									: {}),
							...(payload.lastError ? { lastError: payload.lastError } : {}),
							...(payload.status === "connected" && payload.workspacePath
								? { workspacePath: payload.workspacePath }
								: {}),
							...(payload.status === "connected" &&
							payload.confined !== undefined
								? { confined: payload.confined }
								: {}),
						},
					};
				});
				return matched ? next : prev;
			});
		});
	}, [subscribeEvents]);

	useEffect(() => {
		if (connectionStatus !== "connected" || phase !== "ready") return;
		void refresh();
	}, [connectionStatus, refresh, phase]);

	useEffect(() => {
		if (phase !== "ready") return;
		const timer = setInterval(() => {
			void refresh();
		}, 2_000);
		return () => clearInterval(timer);
	}, [refresh, phase]);

	return (
		<AppShell title="Tools environments" backTo="/settings">
			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-4">
				{(principalPending && phase !== "error") || phase !== "ready" ? (
					<LoadGate
						phase={principalPending && phase !== "error" ? "loading" : phase}
						error={error ?? undefined}
						onRetry={() => setAttempt((value) => value + 1)}
						label="Loading tools environments"
					>
						{null}
					</LoadGate>
				) : null}
				{uncertain && phase === "loading" ? (
					<p role="status" className="text-destructive">
						{uncertain} Reloading the list again; check it before trying again.
					</p>
				) : null}
				{createLost ? (
					<div
						role="status"
						className="flex flex-col gap-2 rounded-md border border-border p-3"
					>
						<p className="text-destructive">{CREATE_PAIR_LOST}</p>
						<button
							type="button"
							className="min-h-tap self-start rounded-md border border-border px-3"
							onClick={() => setCreateLost(false)}
						>
							Dismiss
						</button>
					</div>
				) : null}
				{liveStale && phase === "ready" ? (
					<p role="status" className="text-destructive">
						{liveStale}
					</p>
				) : null}
				{error && phase === "ready" ? (
					<p className="text-destructive">{error}</p>
				) : null}
				{pairing ? (
					<section
						aria-label="Pairing command"
						className="rounded-md border border-border p-3"
					>
						<p className="mb-2 text-[length:var(--fs-sm)]">
							Run this on your machine. The token lasts 15 minutes.
						</p>
						<code className="block break-all text-[length:var(--fs-sm)]">
							{pairing}
						</code>
						<button
							type="button"
							className="mt-2 min-h-tap rounded-md border border-border px-3"
							onClick={() => {
								void navigator.clipboard.writeText(pairing);
							}}
						>
							Copy command
						</button>
					</section>
				) : null}
				{phase === "ready" && !canManage && !principalPending ? (
					<p className="text-[length:var(--fs-sm)] text-text-muted">
						Changing tools environments needs an account admin. Signed-in people
						also need admin mode; API tokens need matching grants.
					</p>
				) : null}
				{phase === "ready" && canManage ? (
					<ElevationHelp
						needed={needsAdmin}
						onEnabled={() => setNeedsAdmin(false)}
					/>
				) : null}
				{!principalPending ? (
					<fieldset
						disabled={phase !== "ready" || busy || !canManage || !!liveStale}
						className={`m-0 flex min-w-0 flex-col gap-4 border-0 p-0 ${phase !== "ready" || busy || !canManage || liveStale ? "opacity-50" : ""}`}
					>
						<form
							className="flex flex-col gap-2"
							aria-disabled={phase !== "ready"}
							onSubmit={(event) => {
								event.preventDefault();
								if (phase !== "ready" || busy || !canManage || liveStale)
									return;
								beginBusy();
								setError(null);
								void client
									.callRpc("account.update", {
										defaultToolsEnv: defaultEnvId
											? { envId: defaultEnvId }
											: null,
									})
									.then((res) => {
										if (!res.ok) {
											if (res.error?.code === "elevation_required")
												setNeedsAdmin(true);
											setError(
												res.error?.message ?? "Could not save the default",
											);
											return;
										}
										return reload();
									})
									.catch(async (err: unknown) => {
										// No answer arrived, so the change may or may not have applied.
										const note = `${err instanceof Error ? err.message : "Network error"}. The change may not have applied.`;
										setRecoveryError(note);
										await reload(note);
									})
									.finally(endBusy);
							}}
						>
							<label className="flex flex-col gap-1">
								<span>Account default</span>
								<select
									aria-label="Account default tools environment"
									className={fieldClass}
									value={defaultEnvId}
									disabled={phase !== "ready" || busy}
									onChange={(event) => setDefaultEnvId(event.target.value)}
								>
									<option value="">None</option>
									{envs.map((env) => (
										<option key={env.envId} value={env.envId}>
											{env.label || env.envId} · {env.kind}
										</option>
									))}
								</select>
							</label>
							<button
								type="submit"
								className="min-h-tap rounded-md bg-accent text-on-accent"
								disabled={phase !== "ready" || busy}
							>
								Save default
							</button>
						</form>
						<ul className="flex flex-col gap-2">
							{envs.map((env) => (
								<li
									key={env.envId}
									className="rounded-md border border-border bg-surface p-3"
								>
									<div className="font-semibold">{env.envId}</div>
									<div className="text-[length:var(--fs-sm)] text-text-muted">
										{env.kind} · {connectionLabel(env)}
									</div>
									<label className="mt-2 flex flex-col gap-1">
										<span>Label</span>
										<input
											aria-label={`Label ${env.envId}`}
											className={fieldClass}
											value={labels[env.envId] ?? ""}
											onChange={(event) =>
												setLabels((prev) => ({
													...prev,
													[env.envId]: event.target.value,
												}))
											}
										/>
									</label>
									<div className="mt-2 flex flex-wrap gap-2">
										<button
											type="button"
											className="min-h-tap rounded-md border border-border px-3"
											disabled={busy}
											onClick={() => {
												beginBusy();
												void client
													.callRpc("account.toolsEnvs.update", {
														envId: env.envId,
														label: labels[env.envId]?.trim() || undefined,
													})
													.then((res) => {
														if (!res.ok) {
															if (res.error?.code === "elevation_required")
																setNeedsAdmin(true);
															setError(
																res.error?.message ?? "Could not update",
															);
														} else return reload();
													})
													.catch(async (err: unknown) => {
														// No answer arrived, so the change may or may not have applied.
														const note = `${err instanceof Error ? err.message : "Network error"}. The change may not have applied.`;
														setRecoveryError(note);
														await reload(note);
													})
													.finally(endBusy);
											}}
										>
											Save
										</button>
										{env.kind === "local-daemon" ? (
											<button
												type="button"
												className="min-h-tap rounded-md border border-border px-3"
												disabled={busy}
												onClick={() => {
													beginBusy();
													void client
														.callRpc<{ command?: string }>(
															"account.toolsEnvs.pair",
															{
																envId: env.envId,
																baseUrl: window.location.origin,
															},
														)
														.then((res) => {
															if (res.ok && res.result?.command) {
																setPairing(res.result.command);
																clearPairError();
																return;
															}
															if (res.error?.code === "elevation_required")
																setNeedsAdmin(true);
															if (
																!res.ok &&
																isRefusal(res.error?.code, "not_found")
															) {
																// Refused before a pairing was minted: an earlier
																// command is unchanged.
																setPairError(
																	res.error?.message ?? "Could not pair",
																);
																return;
															}
															// Failed after execution may have started, or an ok
															// answer without a command: a replacement may exist.
															setPairing(null);
															setPairError(
																`${res.error?.message ?? "No pairing command was returned"}. ${PAIR_AGAIN}`,
															);
														})
														.catch((err: unknown) => {
															// No answer arrived. The server may have issued a new
															// pairing command that replaced any earlier unused one,
															// and a list read cannot recover it. Drop the command on
															// screen, which may no longer be valid.
															setPairing(null);
															setPairError(
																`${err instanceof Error ? err.message : "Network error"}. ${PAIR_AGAIN}`,
															);
														})
														.finally(endBusy);
												}}
											>
												Pair
											</button>
										) : null}
										<button
											type="button"
											className="min-h-tap rounded-md border border-border px-3"
											disabled={busy}
											onClick={() => {
												beginBusy();
												void client
													.callRpc("account.toolsEnvs.delete", {
														envId: env.envId,
													})
													.then((res) => {
														if (!res.ok) {
															if (res.error?.code === "elevation_required")
																setNeedsAdmin(true);
															setError(
																res.error?.message ?? "Could not delete",
															);
														} else return reload();
													})
													.catch(async (err: unknown) => {
														// No answer arrived, so the change may or may not have applied.
														const note = `${err instanceof Error ? err.message : "Network error"}. The change may not have applied.`;
														setRecoveryError(note);
														await reload(note);
													})
													.finally(endBusy);
											}}
										>
											Delete
										</button>
										{canDeregister ? (
											<button
												type="button"
												className="min-h-tap rounded-md border border-destructive px-3 text-destructive"
												disabled={busy}
												onClick={() => {
													const label = env.label || env.envId;
													const message =
														env.kind === "local-daemon"
															? `Deregister daemon ${label}? The token stops working immediately.`
															: `Deregister env ${label}?`;
													if (!window.confirm(message)) return;
													beginBusy();
													void client
														.callRpc("account.toolsEnvs.deregister", {
															envId: env.envId,
														})
														.then((res) => {
															if (!res.ok) {
																if (res.error?.code === "elevation_required")
																	setNeedsAdmin(true);
																setError(
																	res.error?.code === "forbidden"
																		? "Only account owners can deregister an env"
																		: (res.error?.message ??
																				"Could not deregister"),
																);
																return;
															}
															return reload();
														})
														.catch(async (err: unknown) => {
															// No answer arrived, so the change may or may not have applied.
															const note = `${err instanceof Error ? err.message : "Network error"}. The change may not have applied.`;
															setRecoveryError(note);
															await reload(note);
														})
														.finally(endBusy);
												}}
											>
												Deregister
											</button>
										) : null}
									</div>
								</li>
							))}
						</ul>
						<form
							aria-label="Create just-bash env"
							className="flex flex-col gap-2"
							onSubmit={(event) => {
								event.preventDefault();
								if (phase !== "ready" || busy || !canManage || liveStale)
									return;
								beginBusy();
								setError(null);
								void client
									.callRpc("account.toolsEnvs.create", {
										kind: "just-bash",
										label: jbLabel.trim() || undefined,
										persist: jbPersist,
										sharedWorkspace: jbShared,
										confineToWorkspace: true,
									})
									.then((res) => {
										if (!res.ok) {
											if (res.error?.code === "elevation_required")
												setNeedsAdmin(true);
											setError(
												res.error?.message ?? "Could not create just-bash env",
											);
											return;
										}
										setJbLabel("");
										return reload();
									})
									.catch(async (err: unknown) => {
										// No answer arrived, so the change may or may not have applied.
										const note = `${err instanceof Error ? err.message : "Network error"}. The change may not have applied.`;
										setRecoveryError(note);
										await reload(note);
									})
									.finally(endBusy);
							}}
						>
							<h2 className="font-semibold">Create just-bash env</h2>
							<label className="flex flex-col gap-1">
								<span>Label</span>
								<input
									aria-label="just-bash label"
									className={fieldClass}
									value={jbLabel}
									onChange={(event) => setJbLabel(event.target.value)}
								/>
							</label>
							<label className="flex items-center gap-2">
								<input
									type="checkbox"
									checked={jbPersist}
									onChange={(event) => setJbPersist(event.target.checked)}
								/>
								persist
							</label>
							<label className="flex items-center gap-2">
								<input
									type="checkbox"
									checked={jbShared}
									onChange={(event) => setJbShared(event.target.checked)}
								/>
								sharedWorkspace
							</label>
							<button
								type="submit"
								className="min-h-tap rounded-md border border-border"
								disabled={busy}
							>
								Create just-bash env
							</button>
						</form>
						<form
							aria-label="Create daemon env"
							className="flex flex-col gap-2"
							onSubmit={(event) => {
								event.preventDefault();
								if (phase !== "ready" || busy || !canManage || liveStale)
									return;
								beginBusy();
								setError(null);
								void client
									.callRpc<{ command?: string }>("account.toolsEnvs.create", {
										kind: "local-daemon",
										label: daemonLabel.trim() || undefined,
										persist: daemonPersist,
										confineToWorkspace: daemonConfinementPolicy === "required",
										confinementPolicy: daemonConfinementPolicy,
										baseUrl: window.location.origin,
									})
									.then(async (res) => {
										if (res.ok && res.result?.command) {
											setDaemonLabel("");
											setPairing(res.result.command);
											clearPairError();
											return reload();
										}
										if (res.error?.code === "elevation_required")
											setNeedsAdmin(true);
										if (!res.ok && isRefusal(res.error?.code)) {
											setError(
												res.error?.message ?? "Could not create daemon env",
											);
											return;
										}
										// The env, its catalog update or its pairing may be partly
										// done: read the list again and point at Pair.
										const note = `${res.ok ? "The daemon env was created without a pairing command" : (res.error?.message ?? "Could not create daemon env")}. The change may not have fully applied.`;
										setCreateLost(true);
										setRecoveryError(note);
										await reload(note);
									})
									.catch(async (err: unknown) => {
										// No answer arrived, so the change may or may not have applied.
										const note = `${err instanceof Error ? err.message : "Network error"}. The change may not have applied.`;
										setCreateLost(true);
										setRecoveryError(note);
										await reload(note);
									})
									.finally(endBusy);
							}}
						>
							<h2 className="font-semibold">Create local-daemon env</h2>
							<p className="text-[length:var(--fs-sm)] text-text-muted">
								The workspace is the directory where you start the daemon.
							</p>
							<label className="flex flex-col gap-1">
								<span>Label</span>
								<input
									aria-label="Daemon label"
									className={fieldClass}
									value={daemonLabel}
									onChange={(event) => setDaemonLabel(event.target.value)}
								/>
							</label>
							<label className="flex items-center gap-2">
								<input
									type="checkbox"
									checked={daemonPersist}
									onChange={(event) => setDaemonPersist(event.target.checked)}
								/>
								persist
							</label>
							<label className="flex flex-col gap-1">
								<span>Confinement policy</span>
								<select
									aria-label="Confinement policy"
									className={fieldClass}
									value={daemonConfinementPolicy}
									onChange={(event) =>
										setDaemonConfinementPolicy(
											event.target.value as
												| "required"
												| "preferred"
												| "disabled",
										)
									}
								>
									<option value="required">
										Required (sandbox mandatory, rejects unconfined daemons)
									</option>
									<option value="preferred">
										Preferred (sandboxed if supported, unconfined otherwise)
									</option>
									<option value="disabled">
										Disabled (unconfined host access)
									</option>
								</select>
							</label>
							<button
								type="submit"
								className="min-h-tap rounded-md bg-accent text-on-accent"
								disabled={busy}
							>
								Create and pair daemon
							</button>
						</form>
					</fieldset>
				) : null}
			</div>
		</AppShell>
	);
}
