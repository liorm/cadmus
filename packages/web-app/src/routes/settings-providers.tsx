import type {
	CredentialSummary,
	ModelInfo,
	OAuthFlowRecord,
	OAuthProviderInfo,
	ServerEvent,
} from "@cadmus/contract/types";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { fieldClass } from "@/components/SettingsRows";
import {
	HintSkeleton,
	isRefusalMessage,
	LoadError,
	SkeletonBlock,
} from "@/components/Skeleton";
import { useCadmus } from "@/context/CadmusContext";
import { useScopedResource } from "@/hooks/useScopedResource";

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
	const [flow, setFlow] = useState<OAuthFlowRecord | null>(null);
	const [keys, setKeys] = useState<Record<string, string>>({});
	const [prompt, setPrompt] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [note, setNote] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const loaded = useScopedResource("providers", async () => {
		const [creds, oauth, listed] = await Promise.all([
			client.callRpc<{ credentials?: CredentialSummary[] }>(
				"account.credentials.list",
			),
			client.callRpc<{ providers?: OAuthProviderInfo[] }>(
				"account.credentials.oauth.providers",
			),
			client.callRpc<{ models?: ModelInfo[] }>("account.models.list"),
		]);
		if (!creds.ok || !oauth.ok || !listed.ok) {
			throw new Error(
				creds.error?.message ??
					oauth.error?.message ??
					listed.error?.message ??
					"Could not load providers",
			);
		}
		return {
			credentials: creds.result?.credentials ?? [],
			oauthProviders: oauth.result?.providers ?? [],
			models: listed.result?.models ?? [],
		};
	});
	const credentials = loaded.data?.credentials ?? [];
	const oauthProviders = loaded.data?.oauthProviders ?? [];
	const models = loaded.data?.models ?? [];
	const load = loaded.retry;

	useEffect(() => {
		return subscribeEvents((event: ServerEvent) => {
			if (event.type === "account.credentials.oauth.event") {
				setFlow((current) =>
					current && event.payload.flowId === current.flowId
						? event.payload
						: current,
				);
				if (event.payload.status === "completed") load();
			}
			if (
				event.type === "account.event" &&
				(event.payload.action === "credential.set" ||
					event.payload.action === "credential.deleted")
			) {
				load();
			}
		});
	}, [load, subscribeEvents]);

	useEffect(() => {
		if (!flow || ["completed", "failed", "cancelled"].includes(flow.status)) {
			return;
		}
		const timer = setInterval(() => {
			void client
				.callRpc<{ flow?: OAuthFlowRecord }>(
					"account.credentials.oauth.status",
					{
						flowId: flow.flowId,
					},
				)
				.then((res) => {
					if (res.result?.flow) {
						setFlow(res.result.flow);
						if (res.result.flow.status === "completed") load();
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

	// A refused sign-in has nothing to manage here, so the cards are hidden.
	const refused =
		loaded.phase === "error" && isRefusalMessage(loaded.error ?? "");

	return (
		<AppShell title="AI providers" backTo="/settings">
			<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-4">
				{loaded.phase === "error" ? (
					<LoadError
						message={loaded.error ?? "Could not load providers"}
						onRetry={loaded.retry}
					/>
				) : loaded.phase === "loading" ? (
					<SkeletonBlock label="Loading providers" />
				) : null}
				{error ? <p className="text-destructive">{error}</p> : null}
				{note ? <p className="text-[length:var(--fs-sm)]">{note}</p> : null}
				<fieldset
					disabled={loaded.phase !== "ready" || busy}
					className={`flex-col gap-3 border-0 p-0 ${
						refused
							? "hidden"
							: loaded.phase === "ready"
								? "flex"
								: "flex opacity-50"
					}`}
				>
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
												"account.credentials.oauth.submit",
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
										.callRpc("account.credentials.oauth.cancel", {
											flowId: flow.flowId,
										})
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
									{loaded.phase !== "ready" ? (
										<HintSkeleton />
									) : saved ? (
										`${saved.type} saved`
									) : (
										"Not configured"
									)}
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
													"account.credentials.oauth.start",
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
						{loaded.phase === "loading" ? (
							<SkeletonBlock label="Loading models" rows={2} />
						) : loaded.phase === "ready" ? (
							models.length === 0 ? (
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
							)
						) : null}
					</section>
				</fieldset>
			</div>
		</AppShell>
	);
}
