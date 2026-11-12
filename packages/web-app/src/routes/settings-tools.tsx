import type { AccountMember, ToolsEnvRecord } from "@cadmus/contract/types";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { fieldClass } from "@/components/SettingsRows";
import { LoadGate } from "@/components/Skeleton";
import { useCadmus } from "@/context/CadmusContext";
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

export function ToolsSettingsPage() {
	const { client } = useCadmus();
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
	const [busy, setBusy] = useState(false);
	const [phase, setPhase] = useState<LoadPhase>("loading");
	const [attempt, setAttempt] = useState(0);

	const load = useCallback(async () => {
		const [listed, members] = await Promise.all([
			client.callRpc<{
				envs?: ToolsEnvRecord[];
				default?: { envId?: string } | null;
			}>("account.toolsEnvs.list"),
			client.callRpc<{ members?: AccountMember[] }>("account.members.list"),
		]);
		const next = listed.result?.envs ?? [];
		setEnvs(next);
		setDefaultEnvId(listed.result?.default?.envId ?? "");
		setLabels(
			Object.fromEntries(next.map((env) => [env.envId, env.label ?? ""])),
		);
		const me = members.result?.members?.find(
			(member) => member.userId === client.getUserId(),
		);
		setCanDeregister(
			me?.role === "account-admin" || me?.role === "super-admin",
		);
		if (!listed.ok || !members.ok) {
			throw new Error(
				listed.error?.message ??
					members.error?.message ??
					"Could not load tools environments",
			);
		}
	}, [client]);

	useEffect(() => {
		let cancelled = false;
		void attempt;
		setPhase("loading");
		void load()
			.then(() => {
				if (!cancelled) setPhase("ready");
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setPhase("error");
				setError(
					err instanceof Error
						? err.message
						: "Could not load tools environments",
				);
			});
		return () => {
			cancelled = true;
		};
	}, [attempt, load]);

	return (
		<AppShell title="Tools environments" backTo="/settings">
			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-4">
				{phase !== "ready" ? (
					<LoadGate
						phase={phase}
						error={error ?? undefined}
						onRetry={() => setAttempt((value) => value + 1)}
						label="Loading tools environments"
					>
						{null}
					</LoadGate>
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
				<form
					className="flex flex-col gap-2"
					aria-disabled={phase !== "ready"}
					onSubmit={(event) => {
						event.preventDefault();
						setBusy(true);
						setError(null);
						void client
							.callRpc("account.update", {
								defaultToolsEnv: defaultEnvId ? { envId: defaultEnvId } : null,
							})
							.then((res) => {
								if (!res.ok) {
									setError(res.error?.message ?? "Could not save the default");
									return;
								}
								return load();
							})
							.catch((err: unknown) => {
								setError(err instanceof Error ? err.message : "Network error");
							})
							.finally(() => setBusy(false));
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
										setBusy(true);
										void client
											.callRpc("account.toolsEnvs.update", {
												envId: env.envId,
												label: labels[env.envId]?.trim() || undefined,
											})
											.then((res) => {
												if (!res.ok)
													setError(res.error?.message ?? "Could not update");
												else return load();
											})
											.catch((err: unknown) => {
												setError(
													err instanceof Error ? err.message : "Network error",
												);
											})
											.finally(() => setBusy(false));
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
											setBusy(true);
											void client
												.callRpc<{ command?: string }>(
													"account.toolsEnvs.pair",
													{
														envId: env.envId,
														baseUrl: window.location.origin,
													},
												)
												.then((res) => {
													if (!res.ok || !res.result?.command) {
														setError(res.error?.message ?? "Could not pair");
														return;
													}
													setPairing(res.result.command);
												})
												.catch((err: unknown) => {
													setError(
														err instanceof Error
															? err.message
															: "Network error",
													);
												})
												.finally(() => setBusy(false));
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
										setBusy(true);
										void client
											.callRpc("account.toolsEnvs.delete", { envId: env.envId })
											.then((res) => {
												if (!res.ok)
													setError(res.error?.message ?? "Could not delete");
												else return load();
											})
											.catch((err: unknown) => {
												setError(
													err instanceof Error ? err.message : "Network error",
												);
											})
											.finally(() => setBusy(false));
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
											setBusy(true);
											void client
												.callRpc("account.toolsEnvs.deregister", {
													envId: env.envId,
												})
												.then((res) => {
													if (!res.ok) {
														setError(
															res.error?.code === "forbidden"
																? "Only account owners can deregister an env"
																: (res.error?.message ??
																		"Could not deregister"),
														);
														return;
													}
													return load();
												})
												.catch((err: unknown) => {
													setError(
														err instanceof Error
															? err.message
															: "Network error",
													);
												})
												.finally(() => setBusy(false));
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
						setBusy(true);
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
									setError(
										res.error?.message ?? "Could not create just-bash env",
									);
									return;
								}
								setJbLabel("");
								return load();
							})
							.catch((err: unknown) => {
								setError(err instanceof Error ? err.message : "Network error");
							})
							.finally(() => setBusy(false));
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
						setBusy(true);
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
							.then((res) => {
								if (!res.ok) {
									setError(res.error?.message ?? "Could not create daemon env");
									return;
								}
								setDaemonLabel("");
								if (res.result?.command) setPairing(res.result.command);
								return load();
							})
							.catch((err: unknown) => {
								setError(err instanceof Error ? err.message : "Network error");
							})
							.finally(() => setBusy(false));
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
									event.target.value as "required" | "preferred" | "disabled",
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
			</div>
		</AppShell>
	);
}
