import type {
	CredentialSummary,
	ModelInfo,
	OAuthFlowRecord,
	OAuthProviderInfo,
	ServerEvent,
} from "@cadmus/contract/types";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { fieldClass } from "@/components/SettingsRows";
import { useCadmus } from "@/context/CadmusContext";

const KNOWN = [
	{ id: "xai", name: "xAI (Grok)", oauth: true },
	{ id: "anthropic", name: "Anthropic (Claude)", oauth: true },
	{ id: "openai", name: "OpenAI", oauth: true },
	{ id: "google", name: "Google Gemini", oauth: false },
	{ id: "groq", name: "Groq", oauth: false },
	{ id: "openrouter", name: "OpenRouter", oauth: false },
	{ id: "deepseek", name: "DeepSeek", oauth: false },
];

export function ProvidersSettingsPage() {
	const { client, subscribeEvents } = useCadmus();
	const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
	const [oauthProviders, setOauthProviders] = useState<OAuthProviderInfo[]>([]);
	const [models, setModels] = useState<ModelInfo[]>([]);
	const [flow, setFlow] = useState<OAuthFlowRecord | null>(null);
	const [keys, setKeys] = useState<Record<string, string>>({});
	const [prompt, setPrompt] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [note, setNote] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const load = useCallback(async () => {
		const [creds, oauth, listed] = await Promise.all([
			client.callRpc<{ credentials?: CredentialSummary[] }>(
				"account.credentials.list",
			),
			client.callRpc<{ providers?: OAuthProviderInfo[] }>(
				"account.oauth.providers",
			),
			client.callRpc<{ models?: ModelInfo[] }>("account.models.list"),
		]);
		setCredentials(creds.result?.credentials ?? []);
		setOauthProviders(oauth.result?.providers ?? []);
		setModels(listed.result?.models ?? []);
	}, [client]);

	useEffect(() => {
		void load();
	}, [load]);

	useEffect(() => {
		return subscribeEvents((event: ServerEvent) => {
			if (event.type === "account.oauth.event") {
				setFlow((current) =>
					current && event.payload.flowId === current.flowId
						? event.payload
						: current,
				);
				if (event.payload.status === "completed") void load();
			}
			if (
				event.type === "account.event" &&
				(event.payload.action === "credential.set" ||
					event.payload.action === "credential.deleted")
			) {
				void load();
			}
		});
	}, [load, subscribeEvents]);

	useEffect(() => {
		if (!flow || ["completed", "failed", "cancelled"].includes(flow.status)) {
			return;
		}
		const timer = setInterval(() => {
			void client
				.callRpc<{ flow?: OAuthFlowRecord }>("account.oauth.status", {
					flowId: flow.flowId,
				})
				.then((res) => {
					if (res.result?.flow) {
						setFlow(res.result.flow);
						if (res.result.flow.status === "completed") void load();
					}
				});
		}, 2000);
		return () => clearInterval(timer);
	}, [client, flow, load]);

	const ids = Array.from(
		new Set([
			...KNOWN.map((item) => item.id),
			...oauthProviders.map((item) => item.providerId),
		]),
	);

	return (
		<AppShell title="AI providers" backTo="/settings">
			<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-4">
				{error ? <p className="text-destructive">{error}</p> : null}
				{note ? <p className="text-[length:var(--fs-sm)]">{note}</p> : null}
				{flow ? (
					<section
						aria-label="OAuth"
						className="flex flex-col gap-2 rounded-md border border-border p-3"
					>
						<h2 className="font-semibold">
							{flow.providerId} · {flow.status}
						</h2>
						{flow.userCode ? (
							<p>
								Code <span className="font-semibold">{flow.userCode}</span>
							</p>
						) : null}
						{flow.verificationUriComplete || flow.verificationUri ? (
							<a
								className="text-accent underline"
								href={flow.verificationUriComplete || flow.verificationUri}
								target="_blank"
								rel="noreferrer"
							>
								Open verification page
							</a>
						) : null}
						{flow.message ? (
							<p className="text-[length:var(--fs-sm)] text-text-muted">
								{flow.message}
							</p>
						) : null}
						{flow.status === "prompt" && flow.prompt ? (
							<form
								className="flex flex-col gap-2"
								onSubmit={(event) => {
									event.preventDefault();
									setBusy(true);
									void client
										.callRpc<{ flow?: OAuthFlowRecord }>(
											"account.oauth.submit",
											{
												flowId: flow.flowId,
												input: prompt.trim(),
											},
										)
										.then((res) => {
											if (res.result?.flow) setFlow(res.result.flow);
											else setError(res.error?.message ?? "Submit failed");
											setPrompt("");
										})
										.finally(() => setBusy(false));
								}}
							>
								<label className="flex flex-col gap-1">
									<span>{flow.prompt.message}</span>
									<input
										aria-label="OAuth prompt"
										className={fieldClass}
										value={prompt}
										onChange={(event) => setPrompt(event.target.value)}
									/>
								</label>
								<button
									type="submit"
									className="min-h-tap rounded-md border border-border"
									disabled={busy}
								>
									Submit
								</button>
							</form>
						) : null}
						<button
							type="button"
							className="min-h-tap rounded-md border border-border"
							onClick={() => {
								void client
									.callRpc("account.oauth.cancel", { flowId: flow.flowId })
									.then(() => setFlow(null));
							}}
						>
							Cancel sign-in
						</button>
					</section>
				) : null}
				{ids.map((id) => {
					const known = KNOWN.find((item) => item.id === id);
					const oauth = oauthProviders.find((item) => item.providerId === id);
					const saved = credentials.find((item) => item.providerId === id);
					const canOAuth = Boolean(oauth) || Boolean(known?.oauth);
					return (
						<section
							key={id}
							aria-label={known?.name ?? id}
							className="flex flex-col gap-2 rounded-md border border-border bg-surface p-3"
						>
							<h2 className="font-semibold">{known?.name ?? id}</h2>
							<p className="text-[length:var(--fs-sm)] text-text-muted">
								{saved ? `${saved.type} saved` : "Not configured"}
							</p>
							{canOAuth ? (
								<button
									type="button"
									className="min-h-tap rounded-md border border-border"
									disabled={busy}
									onClick={() => {
										setBusy(true);
										setError(null);
										void client
											.callRpc<{ flow?: OAuthFlowRecord }>(
												"account.oauth.start",
												{
													providerId: id,
												},
											)
											.then((res) => {
												if (!res.ok || !res.result?.flow) {
													setError(
														res.error?.message ?? "Could not start sign-in",
													);
													return;
												}
												setFlow(res.result.flow);
											})
											.finally(() => setBusy(false));
									}}
								>
									Sign in
								</button>
							) : null}
							<label className="flex flex-col gap-1">
								<span>API key</span>
								<input
									aria-label={`${id} API key`}
									type="password"
									className={fieldClass}
									value={keys[id] ?? ""}
									onChange={(event) =>
										setKeys((prev) => ({ ...prev, [id]: event.target.value }))
									}
								/>
							</label>
							<div className="flex gap-2">
								<button
									type="button"
									className="min-h-tap flex-1 rounded-md bg-accent text-on-accent"
									disabled={busy || !(keys[id] ?? "").trim()}
									onClick={() => {
										const apiKey = keys[id]?.trim();
										if (!apiKey) return;
										setBusy(true);
										setError(null);
										void client
											.callRpc("account.credentials.set", {
												providerId: id,
												credential: { type: "api_key", apiKey },
											})
											.then((res) => {
												if (!res.ok) {
													setError(
														res.error?.message ?? "Could not save the key",
													);
													return;
												}
												setKeys((prev) => ({ ...prev, [id]: "" }));
												setNote(`API key saved for ${id}`);
												return load();
											})
											.finally(() => setBusy(false));
									}}
								>
									Save key
								</button>
								{saved ? (
									<button
										type="button"
										className="min-h-tap flex-1 rounded-md border border-destructive text-destructive"
										disabled={busy}
										onClick={() => {
											if (!window.confirm(`Remove credentials for ${id}?`))
												return;
											setBusy(true);
											void client
												.callRpc("account.credentials.delete", {
													providerId: id,
												})
												.then((res) => {
													if (!res.ok) {
														setError(
															res.error?.message ??
																"Could not remove credentials",
														);
														return;
													}
													setNote(`Credentials removed for ${id}`);
													return load();
												})
												.finally(() => setBusy(false));
										}}
									>
										Remove
									</button>
								) : null}
							</div>
						</section>
					);
				})}
				<section aria-label="Models" className="flex flex-col gap-1">
					<h2 className="text-[length:var(--fs-xs)] font-semibold uppercase tracking-wide text-text-muted">
						Models
					</h2>
					{models.length === 0 ? (
						<p className="text-[length:var(--fs-sm)] text-text-muted">
							No models listed.
						</p>
					) : (
						<ul className="overflow-hidden rounded-md border border-border bg-surface">
							{models.map((model) => (
								<li
									key={model.id}
									className="border-b border-border px-3 py-2 last:border-b-0"
								>
									<div className="truncate font-semibold">{model.name}</div>
									<div className="truncate text-[length:var(--fs-sm)] text-text-muted">
										{model.id}
									</div>
								</li>
							))}
						</ul>
					)}
				</section>
			</div>
		</AppShell>
	);
}
