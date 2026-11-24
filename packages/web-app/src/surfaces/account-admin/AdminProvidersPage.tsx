import type {
	CredentialSummary,
	ModelInfo,
	OAuthFlowRecord,
	OAuthProviderInfo,
	ServerEvent,
} from "@cadmus/contract/types";
import { CheckCircle2, KeyRound, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { LoadGate } from "@/components/Skeleton";
import { useCadmus } from "@/context/CadmusContext";
import { useElevation } from "@/context/ElevationContext";
import { useScopedResource } from "@/hooks/useScopedResource";
import { groupModelsForSelect } from "@/lib/model-select";
import { AccountAdminShell } from "@/surfaces/account-admin/AccountAdminShell";

const KNOWN_PROVIDERS = [
	{ id: "xai", name: "xAI (Grok)", oauth: true },
	{ id: "anthropic", name: "Anthropic (Claude)", oauth: true },
	{ id: "openai", name: "OpenAI", oauth: true },
	{ id: "google", name: "Google Gemini", oauth: false },
	{ id: "groq", name: "Groq", oauth: false },
	{ id: "openrouter", name: "OpenRouter", oauth: false },
	{ id: "deepseek", name: "DeepSeek", oauth: false },
];

export function AdminProvidersPage() {
	const { client, subscribeEvents } = useCadmus();
	const { runProtected } = useElevation();

	const [keys, setKeys] = useState<Record<string, string>>({});
	const [flow, setFlow] = useState<OAuthFlowRecord | null>(null);
	const [prompt, setPrompt] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [note, setNote] = useState<string | null>(null);
	const [modelQuery, setModelQuery] = useState("");
	const [showAllModels, setShowAllModels] = useState(false);

	const loaded = useScopedResource("admin-providers", async () => {
		const [creds, oauth, modelsRes] = await Promise.all([
			client.callRpc<{ credentials?: CredentialSummary[] }>(
				"account.credentials.list",
			),
			client.callRpc<{ providers?: OAuthProviderInfo[] }>(
				"account.credentials.oauth.providers",
			),
			client.callRpc<{ models?: ModelInfo[] }>("account.models.list"),
		]);
		if (!creds.ok || !oauth.ok || !modelsRes.ok) {
			throw new Error(
				creds.error?.message ??
					oauth.error?.message ??
					modelsRes.error?.message ??
					"Could not load AI providers",
			);
		}
		return {
			credentials: creds.result?.credentials ?? [],
			oauthProviders: oauth.result?.providers ?? [],
			models: modelsRes.result?.models ?? [],
		};
	});

	const retry = loaded.retry;

	useEffect(() => {
		return subscribeEvents((event: ServerEvent) => {
			if (event.type === "account.credentials.oauth.event") {
				setFlow((curr) =>
					curr && event.payload.flowId === curr.flowId ? event.payload : curr,
				);
				if (event.payload.status === "completed") retry();
			}
			if (
				event.type === "account.event" &&
				(event.payload.action === "credential.set" ||
					event.payload.action === "credential.deleted")
			) {
				retry();
			}
		});
	}, [retry, subscribeEvents]);

	useEffect(() => {
		if (!flow || ["completed", "failed", "cancelled"].includes(flow.status)) {
			return;
		}
		const timer = setInterval(() => {
			void client
				.callRpc<{ flow?: OAuthFlowRecord }>(
					"account.credentials.oauth.status",
					{ flowId: flow.flowId },
				)
				.then((res) => {
					if (res.result?.flow) {
						setFlow(res.result.flow);
						if (res.result.flow.status === "completed") retry();
					}
				});
		}, 2000);
		return () => clearInterval(timer);
	}, [client, flow, retry]);

	const credentials = loaded.data?.credentials ?? [];
	const oauthProviders = loaded.data?.oauthProviders ?? [];
	const models = loaded.data?.models ?? [];

	const groupedModels = useMemo(
		() =>
			groupModelsForSelect(models, {
				query: modelQuery,
				showAll: showAllModels,
			}),
		[models, modelQuery, showAllModels],
	);

	const providerIds = Array.from(
		new Set([
			...KNOWN_PROVIDERS.map((p) => p.id),
			...oauthProviders.map((p) => p.providerId),
		]),
	);

	async function handleSaveKey(providerId: string) {
		const apiKey = keys[providerId]?.trim();
		if (!apiKey) return;
		setError(null);
		setNote(null);
		await runProtected(
			`save ${providerId} API key`,
			`Encrypts and stores a BYOK credential for ${providerId} across this account.`,
			async () => {
				setBusy(true);
				const res = await client.callRpc("account.credentials.set", {
					providerId,
					credential: { type: "api_key", apiKey },
				});
				setBusy(false);
				if (!res.ok) {
					setError(res.error?.message ?? "Could not save API key.");
					return;
				}
				setKeys((prev) => ({ ...prev, [providerId]: "" }));
				setNote(`API key saved for ${providerId}.`);
				retry();
			},
		);
	}

	async function handleDeleteCredential(providerId: string) {
		setError(null);
		setNote(null);
		await runProtected(
			`remove ${providerId} credentials`,
			`Deletes the stored credential for ${providerId}. Bots using it will stop working until reconfigured.`,
			async () => {
				setBusy(true);
				const res = await client.callRpc("account.credentials.delete", {
					providerId,
				});
				setBusy(false);
				if (!res.ok) {
					setError(res.error?.message ?? "Could not remove credentials.");
					return;
				}
				setNote(`Credentials removed for ${providerId}.`);
				retry();
			},
		);
	}

	async function handleStartOAuth(providerId: string) {
		setError(null);
		setNote(null);
		await runProtected(
			`connect ${providerId} via OAuth`,
			`Starts an OAuth credential flow for ${providerId}.`,
			async () => {
				setBusy(true);
				const res = await client.callRpc<{ flow?: OAuthFlowRecord }>(
					"account.credentials.oauth.start",
					{ providerId },
				);
				setBusy(false);
				if (!res.ok || !res.result?.flow) {
					setError(res.error?.message ?? "Could not start OAuth sign-in.");
					return;
				}
				setFlow(res.result.flow);
			},
		);
	}

	return (
		<AccountAdminShell activeTab="providers" title="AI Providers & Credentials">
			<div className="space-y-6">
				{error ? (
					<p
						role="alert"
						className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
					>
						{error}
					</p>
				) : null}
				{note ? (
					<p
						role="status"
						className="inline-flex items-center gap-1.5 rounded-lg border border-status-done/40 bg-status-done/10 px-3 py-2 text-xs text-status-done"
					>
						<CheckCircle2 className="h-3.5 w-3.5" />
						{note}
					</p>
				) : null}

				{flow ? (
					<section
						aria-label="Active OAuth flow"
						className="space-y-3 rounded-xl border border-accent/40 bg-accent/10 p-4"
					>
						<div className="flex items-center justify-between gap-2">
							<h2 className="text-sm font-semibold text-text">
								OAuth sign-in: {flow.providerId} ({flow.status})
							</h2>
							<button
								type="button"
								onClick={() => {
									void client
										.callRpc("account.credentials.oauth.cancel", {
											flowId: flow.flowId,
										})
										.then(() => setFlow(null));
								}}
								className="rounded-md border border-border px-2.5 py-1 text-xs text-text-muted hover:text-text"
							>
								Cancel flow
							</button>
						</div>
						{flow.userCode ? (
							<p className="text-xs text-text">
								Verification code:{" "}
								<strong className="font-mono text-accent">
									{flow.userCode}
								</strong>
							</p>
						) : null}
						{flow.verificationUriComplete || flow.verificationUri ? (
							<a
								href={flow.verificationUriComplete || flow.verificationUri}
								target="_blank"
								rel="noreferrer"
								className="inline-block text-xs font-medium text-accent underline"
							>
								Open verification page
							</a>
						) : null}
						{flow.message ? (
							<p className="text-xs text-text-muted">{flow.message}</p>
						) : null}
						{flow.status === "prompt" && flow.prompt ? (
							<form
								onSubmit={(e) => {
									e.preventDefault();
									setBusy(true);
									void client
										.callRpc<{ flow?: OAuthFlowRecord }>(
											"account.credentials.oauth.submit",
											{ flowId: flow.flowId, input: prompt.trim() },
										)
										.then((res) => {
											if (!res.ok) {
												setError(res.error?.message ?? "Submit failed.");
												return;
											}
											if (res.result?.flow) setFlow(res.result.flow);
											setPrompt("");
										})
										.finally(() => setBusy(false));
								}}
								className="flex flex-wrap gap-2"
							>
								<input
									aria-label="OAuth verification code"
									placeholder={flow.prompt.message}
									value={prompt}
									onChange={(e) => setPrompt(e.target.value)}
									className="min-h-tap min-w-[200px] flex-1 rounded-lg border border-border bg-bg px-3 text-xs text-text"
								/>
								<button
									type="submit"
									disabled={busy || !prompt.trim()}
									className="min-h-tap rounded-lg bg-accent px-4 text-xs font-semibold text-on-accent"
								>
									Submit
								</button>
							</form>
						) : null}
					</section>
				) : null}

				<LoadGate
					phase={loaded.phase}
					error={loaded.error}
					onRetry={retry}
					label="Loading providers"
				>
					<div className="grid gap-4 md:grid-cols-2">
						{providerIds.map((id) => {
							const known = KNOWN_PROVIDERS.find((p) => p.id === id);
							const oauth = oauthProviders.find((p) => p.providerId === id);
							const saved = credentials.find((c) => c.providerId === id);
							const canOAuth = Boolean(oauth) || Boolean(known?.oauth);
							return (
								<section
									key={id}
									className="flex flex-col justify-between gap-3 rounded-xl border border-border bg-surface p-4"
								>
									<div>
										<div className="flex items-center justify-between gap-2">
											<h2 className="text-sm font-semibold text-text">
												{known?.name ?? id}
											</h2>
											<span
												className={
													saved
														? "inline-flex items-center gap-1 rounded-full bg-status-done/15 px-2 py-0.5 text-[10px] font-semibold text-status-done"
														: "rounded-full border border-border px-2 py-0.5 text-[10px] text-text-muted"
												}
											>
												{saved ? `${saved.type} active` : "Not configured"}
											</span>
										</div>

										<div className="mt-3 space-y-2">
											<input
												aria-label={`${id} API key`}
												type="password"
												placeholder="Paste API key…"
												value={keys[id] ?? ""}
												onChange={(e) =>
													setKeys((prev) => ({
														...prev,
														[id]: e.target.value,
													}))
												}
												className="min-h-tap w-full rounded-lg border border-border bg-bg px-3 text-xs text-text outline-none focus:border-accent"
											/>
										</div>
									</div>

									<div className="flex flex-wrap items-center gap-2">
										<button
											type="button"
											disabled={busy || !(keys[id] ?? "").trim()}
											onClick={() => void handleSaveKey(id)}
											className="inline-flex min-h-tap items-center gap-1 rounded-lg bg-accent px-3 text-xs font-semibold text-on-accent hover:opacity-90 disabled:opacity-40"
										>
											<KeyRound className="h-3.5 w-3.5" />
											Save key
										</button>
										{canOAuth ? (
											<button
												type="button"
												disabled={busy}
												onClick={() => void handleStartOAuth(id)}
												className="min-h-tap rounded-lg border border-border px-3 text-xs font-medium text-text hover:bg-surface-raised disabled:opacity-40"
											>
												OAuth sign-in
											</button>
										) : null}
										{saved ? (
											<button
												type="button"
												disabled={busy}
												onClick={() => void handleDeleteCredential(id)}
												className="inline-flex min-h-tap items-center gap-1 rounded-lg border border-destructive/40 px-2.5 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-40"
											>
												<Trash2 className="h-3.5 w-3.5" />
												Remove
											</button>
										) : null}
									</div>
								</section>
							);
						})}
					</div>

					<section className="space-y-4 rounded-xl border border-border bg-surface p-4">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<h2 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
								Available Models ({groupedModels.visibleCount} of{" "}
								{groupedModels.totalCount})
							</h2>
							<div className="flex flex-wrap items-center gap-2">
								<label className="relative flex items-center">
									<Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-text-muted" />
									<input
										type="text"
										aria-label="Search available models"
										placeholder="Search models…"
										value={modelQuery}
										onChange={(e) => setModelQuery(e.target.value)}
										className="h-8 rounded-lg border border-border bg-bg pl-8 pr-2.5 text-xs text-text outline-none focus:border-accent"
									/>
								</label>
								{!modelQuery.trim() &&
								(groupedModels.hiddenCount > 0 || showAllModels) ? (
									<button
										type="button"
										onClick={() => setShowAllModels((prev) => !prev)}
										className="h-8 rounded-lg border border-border px-2.5 text-xs font-medium text-accent hover:bg-surface-raised"
									>
										{showAllModels
											? "Show popular only"
											: `Show all (${groupedModels.totalCount})`}
									</button>
								) : null}
							</div>
						</div>
						{groupedModels.groups.length === 0 ? (
							<p className="text-xs text-text-muted">No models listed.</p>
						) : (
							<div className="space-y-4">
								{groupedModels.groups.map((group) => (
									<div key={group.provider} className="space-y-2">
										<div className="flex items-center justify-between">
											<h3 className="text-xs font-semibold text-text">
												{group.label}
											</h3>
											<span className="text-[11px] text-text-muted">
												{group.items.length}{" "}
												{group.items.length === 1 ? "model" : "models"}
												{group.authenticated ? "" : " · no key"}
											</span>
										</div>
										<div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
											{group.items.map((item) => (
												<div
													key={item.ref}
													className="rounded-lg border border-border bg-bg/50 px-3 py-2 text-xs"
												>
													<div className="flex items-center justify-between gap-1.5">
														<span className="truncate font-semibold text-text">
															{item.model.name}
														</span>
														{item.tier !== "other" ? (
															<span
																className={
																	item.tier === "frontier"
																		? "shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-accent"
																		: "shrink-0 rounded bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium uppercase text-text-muted"
																}
															>
																{item.tier}
															</span>
														) : null}
													</div>
													<div className="truncate font-mono text-[11px] text-text-muted">
														{item.ref}
													</div>
												</div>
											))}
										</div>
									</div>
								))}
							</div>
						)}
					</section>
				</LoadGate>
			</div>
		</AccountAdminShell>
	);
}
