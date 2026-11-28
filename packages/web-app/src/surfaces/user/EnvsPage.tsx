import type { ServerEvent, ToolsEnvRecord } from "@cadmus/contract/types";
import { Copy, KeyRound, Plus, Terminal, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AddEntityDialog } from "@/components/chrome/AddEntityDialog";
import { LoadGate } from "@/components/Skeleton";
import { useCadmus } from "@/context/CadmusContext";
import { useScopedResource } from "@/hooks/useScopedResource";
import { UserShell } from "@/surfaces/user/UserShell";

function connectionSummary(env: ToolsEnvRecord): string {
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
	return `${status}${workspace}${confinement}`;
}

export function EnvsPage() {
	return (
		<UserShell activeTab="envs" mobileTitle="Tools Environments">
			<EnvsPanel />
		</UserShell>
	);
}

export function EnvsPanel({ embedded = false }: { embedded?: boolean }) {
	const { client, subscribeEvents } = useCadmus();
	const loaded = useScopedResource("tools-envs", async () => {
		const res = await client.callRpc<{
			envs?: ToolsEnvRecord[];
			default?: { envId?: string } | null;
			canDeregister?: boolean;
		}>("account.toolsEnvs.list");
		if (!res.ok) {
			throw new Error(
				res.error?.message ?? "Could not load tools environments",
			);
		}
		return {
			envs: res.result?.envs ?? [],
			defaultEnvId: res.result?.default?.envId ?? null,
			canDeregister: res.result?.canDeregister ?? true,
		};
	});

	const [envs, setEnvs] = useState<ToolsEnvRecord[]>([]);
	const [labels, setLabels] = useState<Record<string, string>>({});
	const [error, setError] = useState<string | null>(null);
	const [pairingCmd, setPairingCmd] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	// Add dialog state
	const [addOpen, setAddOpen] = useState(false);
	const [kind, setKind] = useState<"just-bash" | "local-daemon">("just-bash");
	const [newLabel, setNewLabel] = useState("");
	const [persist, setPersist] = useState(true);
	const [shared, setShared] = useState(false);
	const [policy, setPolicy] = useState<"required" | "preferred" | "disabled">(
		"required",
	);

	useEffect(() => {
		if (!loaded.data) return;
		setEnvs(loaded.data.envs);
		setLabels(
			Object.fromEntries(
				loaded.data.envs.map((env) => [env.envId, env.label ?? ""]),
			),
		);
	}, [loaded.data]);

	useEffect(() => {
		return subscribeEvents((event: ServerEvent) => {
			if (event.type !== "account.toolsEnv.event") return;
			const p = event.payload;
			setEnvs((prev) =>
				prev.map((env) =>
					env.envId !== p.envId
						? env
						: {
								...env,
								connection: {
									status: p.status,
									...(p.connectedAt !== undefined
										? { connectedAt: p.connectedAt }
										: env.connection?.connectedAt !== undefined
											? { connectedAt: env.connection.connectedAt }
											: {}),
									...(p.lastError ? { lastError: p.lastError } : {}),
									...(p.status === "connected" && p.workspacePath
										? { workspacePath: p.workspacePath }
										: {}),
									...(p.status === "connected" && p.confined !== undefined
										? { confined: p.confined }
										: {}),
								},
							},
				),
			);
		});
	}, [subscribeEvents]);

	const reload = useCallback(() => {
		loaded.retry();
	}, [loaded]);

	async function handleCreateEnv(e: React.FormEvent) {
		e.preventDefault();
		if (busy) return;
		setBusy(true);
		setError(null);
		const payload =
			kind === "just-bash"
				? {
						kind: "just-bash" as const,
						label: newLabel.trim() || undefined,
						persist,
						sharedWorkspace: shared,
					}
				: {
						kind: "local-daemon" as const,
						label: newLabel.trim() || undefined,
						persist,
						confinementPolicy: policy,
						baseUrl: window.location.origin,
					};
		const res = await client.callRpc<{
			env?: ToolsEnvRecord;
			command?: string;
		}>("account.toolsEnvs.create", payload);
		setBusy(false);
		if (!res.ok) {
			setError(res.error?.message ?? "Could not create tools environment.");
			return;
		}
		if (res.result?.command) {
			setPairingCmd(res.result.command);
		}
		setNewLabel("");
		setAddOpen(false);
		reload();
	}

	async function handleSaveLabel(envId: string) {
		setBusy(true);
		setError(null);
		const res = await client.callRpc("account.toolsEnvs.update", {
			envId,
			label: labels[envId]?.trim() || undefined,
		});
		setBusy(false);
		if (!res.ok) {
			setError(res.error?.message ?? "Could not rename environment.");
			return;
		}
		reload();
	}

	async function handlePair(envId: string) {
		setBusy(true);
		setError(null);
		const res = await client.callRpc<{ command?: string }>(
			"account.toolsEnvs.pair",
			{ envId, baseUrl: window.location.origin },
		);
		setBusy(false);
		if (!res.ok || !res.result?.command) {
			setError(res.error?.message ?? "Could not issue pairing command.");
			return;
		}
		setPairingCmd(res.result.command);
	}

	async function handleDelete(envId: string) {
		if (!window.confirm(`Delete environment ${envId}?`)) return;
		setBusy(true);
		setError(null);
		const res = await client.callRpc("account.toolsEnvs.delete", { envId });
		setBusy(false);
		if (!res.ok) {
			setError(res.error?.message ?? "Could not delete environment.");
			return;
		}
		reload();
	}

	return (
		<>
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
				{!embedded ? (
					<header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface px-4 py-3 sm:px-6">
						<div className="flex items-center gap-2.5">
							<Terminal className="h-5 w-5 text-accent" />
							<div>
								<h1 className="text-sm font-semibold text-text">
									Tools Environments
								</h1>
								<p className="text-xs text-text-muted">
									Manage sandboxed bash &amp; local daemon workspaces without
									admin elevation
								</p>
							</div>
						</div>
						<button
							type="button"
							onClick={() => {
								setError(null);
								setAddOpen(true);
							}}
							className="inline-flex min-h-tap items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-semibold text-on-accent hover:opacity-90"
						>
							<Plus className="h-3.5 w-3.5" />
							New environment
						</button>
					</header>
				) : (
					<div className="flex items-center justify-between gap-2 pb-3">
						<p className="text-xs text-text-muted">
							Manage sandboxed bash &amp; local daemon workspaces.
						</p>
						<button
							type="button"
							onClick={() => {
								setError(null);
								setAddOpen(true);
							}}
							className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-accent px-2.5 text-xs font-semibold text-on-accent hover:opacity-90"
						>
							<Plus className="h-3.5 w-3.5" />
							New environment
						</button>
					</div>
				)}

				<div className="mx-auto w-full max-w-4xl space-y-4 p-4 sm:p-6">
					{error ? (
						<div
							role="alert"
							className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
						>
							{error}
						</div>
					) : null}

					{pairingCmd ? (
						<div className="rounded-xl border border-accent/40 bg-accent/10 p-3 text-xs">
							<div className="flex items-center justify-between gap-2">
								<span className="font-semibold text-accent">
									Daemon pairing command
								</span>
								<button
									type="button"
									onClick={() =>
										void navigator.clipboard?.writeText(pairingCmd)
									}
									className="inline-flex items-center gap-1 rounded border border-accent/40 px-2 py-1 text-[11px] font-medium text-accent"
								>
									<Copy className="h-3 w-3" />
									Copy
								</button>
							</div>
							<pre className="mt-2 overflow-x-auto rounded-lg bg-bg p-2.5 font-mono text-[11px] text-text">
								{pairingCmd}
							</pre>
						</div>
					) : null}

					<LoadGate
						phase={loaded.phase}
						error={loaded.error}
						onRetry={reload}
						label="Loading tools environments"
					>
						{envs.length === 0 ? (
							<div className="rounded-xl border border-dashed border-border bg-surface p-8 text-center text-xs text-text-muted">
								No tools environments configured yet. Create a sandboxed
								just-bash environment or pair a local daemon.
							</div>
						) : (
							<ul className="space-y-3">
								{envs.map((env) => {
									const isDefault = loaded.data?.defaultEnvId === env.envId;
									return (
										<li
											key={env.envId}
											className="rounded-xl border border-border bg-surface p-4"
										>
											<div className="flex flex-wrap items-center justify-between gap-2">
												<div className="min-w-0">
													<div className="flex items-center gap-2">
														<span className="font-mono text-xs font-semibold text-text">
															{env.envId}
														</span>
														<span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-text-muted">
															{env.kind}
														</span>
														{isDefault ? (
															<span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold text-accent">
																Account default
															</span>
														) : null}
													</div>
													<div className="mt-1 text-xs text-text-muted">
														{connectionSummary(env)}
													</div>
												</div>
											</div>

											<div className="mt-3 flex flex-wrap items-center gap-2">
												<input
													aria-label={`Label for ${env.envId}`}
													value={labels[env.envId] ?? ""}
													onChange={(e) =>
														setLabels((prev) => ({
															...prev,
															[env.envId]: e.target.value,
														}))
													}
													placeholder="Display label"
													className="min-h-tap min-w-[180px] flex-1 rounded-lg border border-border bg-bg px-3 text-xs text-text outline-none focus:border-accent"
												/>
												<button
													type="button"
													disabled={busy}
													onClick={() => void handleSaveLabel(env.envId)}
													className="min-h-tap rounded-lg border border-border px-3 text-xs font-medium text-text hover:bg-surface-raised disabled:opacity-50"
												>
													Save label
												</button>
												{env.kind === "local-daemon" ? (
													<button
														type="button"
														disabled={busy}
														onClick={() => void handlePair(env.envId)}
														className="inline-flex min-h-tap items-center gap-1 rounded-lg border border-accent/40 px-3 text-xs font-medium text-accent hover:bg-accent/10 disabled:opacity-50"
													>
														<KeyRound className="h-3.5 w-3.5" />
														Pair
													</button>
												) : null}
												{loaded.data?.canDeregister !== false ? (
													<button
														type="button"
														disabled={busy}
														onClick={() => void handleDelete(env.envId)}
														className="inline-flex min-h-tap items-center gap-1 rounded-lg border border-destructive/40 px-3 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
													>
														<Trash2 className="h-3.5 w-3.5" />
														Delete
													</button>
												) : null}
											</div>
										</li>
									);
								})}
							</ul>
						)}
					</LoadGate>
				</div>
			</div>

			<AddEntityDialog
				open={addOpen}
				onClose={() => setAddOpen(false)}
				title="New Tools Environment"
				description="Attach a sandboxed just-bash runtime or a local confinement daemon."
			>
				<form onSubmit={(e) => void handleCreateEnv(e)} className="space-y-4">
					<div className="grid grid-cols-2 gap-2">
						{(["just-bash", "local-daemon"] as const).map((opt) => (
							<button
								key={opt}
								type="button"
								onClick={() => setKind(opt)}
								className={
									kind === opt
										? "min-h-tap rounded-lg border border-accent bg-accent/15 px-3 text-xs font-semibold text-accent"
										: "min-h-tap rounded-lg border border-border bg-bg px-3 text-xs font-medium text-text-muted hover:text-text"
								}
							>
								{opt}
							</button>
						))}
					</div>
					<label className="block space-y-1">
						<span className="text-xs font-medium text-text-muted">Label</span>
						<input
							aria-label="Environment label"
							value={newLabel}
							onChange={(e) => setNewLabel(e.target.value)}
							placeholder="e.g. Build workstation"
							className="min-h-tap w-full rounded-lg border border-border bg-bg px-3 text-sm text-text outline-none focus:border-accent"
						/>
					</label>
					<label className="flex items-center gap-2 text-xs text-text">
						<input
							type="checkbox"
							checked={persist}
							onChange={(e) => setPersist(e.target.checked)}
						/>
						Persist workspace changes across sessions
					</label>
					{kind === "just-bash" ? (
						<label className="flex items-center gap-2 text-xs text-text">
							<input
								type="checkbox"
								checked={shared}
								onChange={(e) => setShared(e.target.checked)}
							/>
							Shared across bots in this account
						</label>
					) : (
						<label className="block space-y-1">
							<span className="text-xs font-medium text-text-muted">
								Confinement policy
							</span>
							<select
								aria-label="Confinement policy"
								value={policy}
								onChange={(e) =>
									setPolicy(
										e.target.value as "required" | "preferred" | "disabled",
									)
								}
								className="min-h-tap w-full rounded-lg border border-border bg-bg px-3 text-sm text-text"
							>
								<option value="required">Required (sandbox enforced)</option>
								<option value="preferred">Preferred</option>
								<option value="disabled">Disabled</option>
							</select>
						</label>
					)}
					<div className="flex justify-end gap-2">
						<button
							type="button"
							onClick={() => setAddOpen(false)}
							className="min-h-tap rounded-lg border border-border px-4 text-xs text-text-muted"
						>
							Cancel
						</button>
						<button
							type="submit"
							disabled={busy}
							className="min-h-tap rounded-lg bg-accent px-4 text-xs font-semibold text-on-accent disabled:opacity-50"
						>
							{busy ? "Creating…" : "Create environment"}
						</button>
					</div>
				</form>
			</AddEntityDialog>
		</>
	);
}
