import { useCallback, useEffect, useState } from "react";
import type {
	CredentialSummary,
	OAuthFlowRecord,
	OAuthProviderInfo,
	ServerEvent,
} from "../../../src/protocol.js";
import { useCadmus } from "../context/CadmusContext.js";

export interface ProviderAuthModalProps {
	isOpen: boolean;
	onClose: () => void;
	initialProviderId?: string;
}

interface KnownProviderMeta {
	id: string;
	name: string;
	icon: string;
	description: string;
	supportsOAuth?: boolean;
	defaultLoginLabel?: string;
}

const KNOWN_PROVIDERS: KnownProviderMeta[] = [
	{
		id: "xai",
		name: "xAI (Grok)",
		icon: "⚡",
		description: "SuperGrok & X Premium OAuth, or Grok API Key",
		supportsOAuth: true,
		defaultLoginLabel: "Sign in with SuperGrok or X Premium",
	},
	{
		id: "anthropic",
		name: "Anthropic (Claude)",
		icon: "🧠",
		description: "Claude Pro/Max OAuth or Anthropic API Key",
		supportsOAuth: true,
		defaultLoginLabel: "Sign in with Claude Pro/Max",
	},
	{
		id: "openai",
		name: "OpenAI",
		icon: "🤖",
		description: "OpenAI API Key or ChatGPT OAuth",
		supportsOAuth: true,
		defaultLoginLabel: "Sign in with OpenAI",
	},
	{
		id: "google",
		name: "Google Gemini",
		icon: "✨",
		description: "Google AI Studio API Key",
		supportsOAuth: false,
	},
	{
		id: "groq",
		name: "Groq",
		icon: "🚀",
		description: "Ultra-fast inference API Key",
		supportsOAuth: false,
	},
	{
		id: "openrouter",
		name: "OpenRouter",
		icon: "🌐",
		description: "Multi-provider routing API Key",
		supportsOAuth: false,
	},
	{
		id: "deepseek",
		name: "DeepSeek",
		icon: "🐋",
		description: "DeepSeek API Key",
		supportsOAuth: false,
	},
];

export function ProviderAuthModal({
	isOpen,
	onClose,
	initialProviderId,
}: ProviderAuthModalProps) {
	const { client, refreshModels } = useCadmus();

	const [oauthProviders, setOauthProviders] = useState<OAuthProviderInfo[]>([]);
	const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
	const [activeFlow, setActiveFlow] = useState<OAuthFlowRecord | null>(null);

	const [expandedApiKeyProvider, setExpandedApiKeyProvider] = useState<
		string | null
	>(null);
	const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({});
	const [interactiveInput, setInteractiveInput] = useState("");

	const [isBusy, setIsBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [successMessage, setSuccessMessage] = useState<string | null>(null);
	const [copiedCode, setCopiedCode] = useState(false);

	const loadData = useCallback(async () => {
		try {
			const [credsRes, oauthRes] = await Promise.all([
				client.callRpc("account.credentials.list"),
				client.callRpc("account.oauth.providers"),
			]);

			if (credsRes.ok && credsRes.result?.credentials) {
				setCredentials(credsRes.result.credentials);
			}
			if (oauthRes.ok && oauthRes.result?.providers) {
				setOauthProviders(oauthRes.result.providers);
			}
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to load credentials",
			);
		}
	}, [client]);

	// Load data when opened
	useEffect(() => {
		if (!isOpen) {
			setActiveFlow(null);
			setError(null);
			setSuccessMessage(null);
			setExpandedApiKeyProvider(null);
			return;
		}

		void loadData();

		if (initialProviderId) {
			setExpandedApiKeyProvider(initialProviderId);
		}
	}, [isOpen, loadData, initialProviderId]);

	// Listen for WebSocket OAuth and Account events
	useEffect(() => {
		if (!isOpen) return;

		const unsub = client.subscribe((event: ServerEvent) => {
			if (event.type === "account.oauth.event") {
				const flow = event.payload;
				if (activeFlow && flow.flowId === activeFlow.flowId) {
					setActiveFlow(flow);
					if (flow.status === "completed") {
						setSuccessMessage(
							`Successfully authenticated with ${flow.providerId}!`,
						);
						void loadData();
						void refreshModels();
					} else if (flow.status === "failed") {
						setError(
							flow.error?.message ?? flow.message ?? "Authentication failed",
						);
					}
				}
			} else if (event.type === "account.event") {
				if (
					event.payload.action === "credential.set" ||
					event.payload.action === "credential.deleted"
				) {
					void loadData();
					void refreshModels();
				}
			}
		});

		return () => unsub();
	}, [isOpen, client, activeFlow, loadData, refreshModels]);

	// Polling fallback while OAuth flow is pending or in progress
	useEffect(() => {
		if (
			!isOpen ||
			!activeFlow ||
			activeFlow.status === "completed" ||
			activeFlow.status === "failed" ||
			activeFlow.status === "cancelled"
		) {
			return;
		}

		const timer = setInterval(async () => {
			try {
				const res = await client.callRpc("account.oauth.status", {
					flowId: activeFlow.flowId,
				});
				if (res.ok && res.result?.flow) {
					const flow = res.result.flow;
					setActiveFlow(flow);
					if (flow.status === "completed") {
						setSuccessMessage(
							`Successfully authenticated with ${flow.providerId}!`,
						);
						void loadData();
						void refreshModels();
					} else if (flow.status === "failed") {
						setError(
							flow.error?.message ?? flow.message ?? "Authentication failed",
						);
					}
				}
			} catch {
				// Ignore transient polling errors
			}
		}, 2000);

		return () => clearInterval(timer);
	}, [isOpen, activeFlow, client, loadData, refreshModels]);

	if (!isOpen) return null;

	// Start OAuth login (e.g. for xAI)
	const handleStartOAuth = async (providerId: string) => {
		setIsBusy(true);
		setError(null);
		setSuccessMessage(null);
		try {
			const res = await client.callRpc("account.oauth.start", { providerId });
			if (!res.ok || !res.result?.flow) {
				setError(
					res.error?.message ?? `Failed to start OAuth for ${providerId}`,
				);
				return;
			}
			setActiveFlow(res.result.flow);
		} catch (err) {
			setError(
				err instanceof Error
					? err.message
					: `Failed to initiate OAuth for ${providerId}`,
			);
		} finally {
			setIsBusy(false);
		}
	};

	// Cancel active OAuth flow
	const handleCancelOAuth = async () => {
		if (!activeFlow) return;
		setIsBusy(true);
		try {
			await client.callRpc("account.oauth.cancel", {
				flowId: activeFlow.flowId,
			});
			setActiveFlow(null);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to cancel OAuth flow",
			);
		} finally {
			setIsBusy(false);
		}
	};

	// Submit interactive prompt
	const handleSubmitInteractive = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!activeFlow || !interactiveInput.trim()) return;

		setIsBusy(true);
		setError(null);
		try {
			const res = await client.callRpc("account.oauth.submit", {
				flowId: activeFlow.flowId,
				input: interactiveInput.trim(),
			});
			if (res.ok && res.result?.flow) {
				setActiveFlow(res.result.flow);
				setInteractiveInput("");
			} else {
				setError(res.error?.message ?? "Failed to submit input");
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Submission failed");
		} finally {
			setIsBusy(false);
		}
	};

	// Copy device user code
	const handleCopyCode = async (code: string) => {
		try {
			await navigator.clipboard.writeText(code);
			setCopiedCode(true);
			setTimeout(() => setCopiedCode(false), 2000);
		} catch {
			// Fallback: clipboard permission denied
		}
	};

	// Save manual API Key
	const handleSaveApiKey = async (providerId: string) => {
		const apiKey = apiKeyInputs[providerId]?.trim();
		if (!apiKey) return;

		setIsBusy(true);
		setError(null);
		try {
			const res = await client.callRpc("account.credentials.set", {
				providerId,
				credential: { type: "api_key", apiKey },
			});
			if (!res.ok) {
				setError(
					res.error?.message ?? `Failed to save API key for ${providerId}`,
				);
				return;
			}
			setApiKeyInputs((prev) => ({ ...prev, [providerId]: "" }));
			setExpandedApiKeyProvider(null);
			setSuccessMessage(`API Key saved for ${providerId}`);
			await loadData();
			await refreshModels();
		} catch (err) {
			setError(
				err instanceof Error
					? err.message
					: `Failed to save API key for ${providerId}`,
			);
		} finally {
			setIsBusy(false);
		}
	};

	// Delete credential
	const handleDeleteCredential = async (providerId: string) => {
		if (
			!confirm(
				`Are you sure you want to disconnect/remove credentials for ${providerId}?`,
			)
		) {
			return;
		}

		setIsBusy(true);
		setError(null);
		try {
			const res = await client.callRpc("account.credentials.delete", {
				providerId,
			});
			if (!res.ok) {
				setError(
					res.error?.message ??
						`Failed to remove credentials for ${providerId}`,
				);
				return;
			}
			setSuccessMessage(`Credentials removed for ${providerId}`);
			await loadData();
			await refreshModels();
		} catch (err) {
			setError(
				err instanceof Error
					? err.message
					: `Failed to remove credentials for ${providerId}`,
			);
		} finally {
			setIsBusy(false);
		}
	};

	// Merge known providers with discoverable OAuth providers
	const allProviderIds = Array.from(
		new Set([
			...KNOWN_PROVIDERS.map((p) => p.id),
			...oauthProviders.map((p) => p.providerId),
		]),
	);

	return (
		<div className="modal-backdrop">
			<button
				type="button"
				className="modal-backdrop-dismiss"
				onClick={onClose}
				aria-label="Close dialog"
			/>
			<div
				className="modal-container"
				role="dialog"
				aria-modal="true"
				style={{ position: "relative", zIndex: 1, maxWidth: "660px" }}
			>
				{/* Modal Header */}
				<div className="modal-header">
					<div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
						<span style={{ fontSize: "18px" }}>🔑</span>
						<h3 className="modal-title">AI Providers & Authentication</h3>
					</div>
					<button
						type="button"
						className="btn btn-ghost btn-sm"
						onClick={onClose}
						aria-label="Close dialog"
					>
						✕
					</button>
				</div>

				<div className="modal-body">
					{/* Status / Error Alerts */}
					{error && (
						<div
							className="alert-banner alert-error"
							style={{ marginBottom: "12px" }}
						>
							{error}
						</div>
					)}
					{successMessage && (
						<div
							className="alert-banner alert-success"
							style={{ marginBottom: "12px" }}
						>
							{successMessage}
						</div>
					)}

					{/* ── Active OAuth Flow View ─────────────────────────────── */}
					{activeFlow ? (
						<div className="oauth-flow-container">
							<div
								style={{
									display: "flex",
									justifyContent: "space-between",
									alignItems: "center",
									paddingBottom: "8px",
									borderBottom: "1px solid var(--border-subtle)",
								}}
							>
								<div>
									<h4
										style={{
											fontSize: "15px",
											fontWeight: 600,
											color: "var(--text-primary)",
										}}
									>
										{activeFlow.providerId === "xai"
											? "⚡ xAI (SuperGrok / X Premium)"
											: `${activeFlow.providerId.toUpperCase()} Sign-In`}
									</h4>
									<span
										style={{ fontSize: "12px", color: "var(--text-muted)" }}
									>
										{activeFlow.flowType === "device_code"
											? "Device Code Authorization"
											: "Browser Authorization"}
									</span>
								</div>
								<span
									className={`badge ${
										activeFlow.status === "completed"
											? "badge-emerald"
											: activeFlow.status === "failed"
												? "badge-rose"
												: "badge-indigo"
									}`}
								>
									{activeFlow.status}
								</span>
							</div>

							{/* Device Code Flow (e.g. xAI) */}
							{activeFlow.flowType === "device_code" && (
								<>
									{activeFlow.userCode && (
										<div className="oauth-step">
											<span className="oauth-step-title">
												Step 1: Your One-Time Authorization Code
											</span>
											<div className="oauth-code-display">
												<span className="oauth-code-text">
													{activeFlow.userCode}
												</span>
												<button
													type="button"
													className="btn btn-secondary btn-sm"
													onClick={() =>
														handleCopyCode(activeFlow.userCode ?? "")
													}
												>
													{copiedCode ? "✓ Copied" : "📋 Copy Code"}
												</button>
											</div>
											<span className="form-hint">
												Copy this code to paste into the xAI verification page.
											</span>
										</div>
									)}

									{(activeFlow.verificationUriComplete ||
										activeFlow.verificationUri) && (
										<div className="oauth-step">
											<span className="oauth-step-title">
												Step 2: Authorize in Browser
											</span>
											<p
												style={{
													fontSize: "12px",
													color: "var(--text-secondary)",
												}}
											>
												Open the xAI activation page, sign in with your X
												account, and confirm the code above.
											</p>
											<div style={{ marginTop: "4px" }}>
												<a
													href={
														activeFlow.verificationUriComplete ||
														activeFlow.verificationUri
													}
													target="_blank"
													rel="noopener noreferrer"
													className="btn btn-primary"
													style={{
														display: "inline-flex",
														alignItems: "center",
														gap: "6px",
														textDecoration: "none",
													}}
												>
													Open xAI Verification Page ↗
												</a>
											</div>
											<span
												className="form-hint"
												style={{ wordBreak: "break-all" }}
											>
												URL: {activeFlow.verificationUri}
											</span>
										</div>
									)}

									<div className="oauth-step">
										<span className="oauth-step-title">Step 3: Status</span>
										<div className="oauth-waiting-status">
											{activeFlow.status === "pending" ||
											activeFlow.status === "progress" ? (
												<>
													<span className="oauth-status-dot" />
													<span>
														{activeFlow.message ??
															"Waiting for authorization in your browser..."}
													</span>
												</>
											) : activeFlow.status === "completed" ? (
												<span style={{ color: "var(--accent-emerald)" }}>
													✓ Authorization complete! Credentials saved.
												</span>
											) : (
												<span style={{ color: "var(--accent-rose)" }}>
													✕ {activeFlow.error?.message ?? activeFlow.message}
												</span>
											)}
										</div>
									</div>
								</>
							)}

							{/* Interactive prompt fallback */}
							{activeFlow.status === "prompt" && activeFlow.prompt && (
								<form onSubmit={handleSubmitInteractive} className="oauth-step">
									<span className="oauth-step-title">Input Required</span>
									<p
										style={{
											fontSize: "13px",
											color: "var(--text-primary)",
										}}
									>
										{activeFlow.prompt.message}
									</p>

									{activeFlow.prompt.type === "select" &&
									activeFlow.prompt.options ? (
										<select
											className="select"
											value={interactiveInput}
											onChange={(e) => setInteractiveInput(e.target.value)}
											required
										>
											<option value="">Choose an option...</option>
											{activeFlow.prompt.options.map((opt) => (
												<option key={opt.id} value={opt.id}>
													{opt.label}{" "}
													{opt.description ? `(${opt.description})` : ""}
												</option>
											))}
										</select>
									) : (
										<input
											type={
												activeFlow.prompt.type === "secret"
													? "password"
													: "text"
											}
											className="input"
											placeholder={
												activeFlow.prompt.placeholder ?? "Enter value..."
											}
											value={interactiveInput}
											onChange={(e) => setInteractiveInput(e.target.value)}
											required
										/>
									)}

									<button
										type="submit"
										className="btn btn-primary btn-sm"
										disabled={isBusy || !interactiveInput.trim()}
										style={{ alignSelf: "flex-start", marginTop: "6px" }}
									>
										Submit
									</button>
								</form>
							)}

							{/* Flow Actions */}
							<div
								style={{
									display: "flex",
									justifyContent: "space-between",
									alignItems: "center",
									marginTop: "8px",
								}}
							>
								<button
									type="button"
									className="btn btn-secondary btn-sm"
									onClick={handleCancelOAuth}
									disabled={isBusy}
								>
									Cancel Flow
								</button>
								{activeFlow.status === "completed" && (
									<button
										type="button"
										className="btn btn-primary btn-sm"
										onClick={() => setActiveFlow(null)}
									>
										Done
									</button>
								)}
							</div>
						</div>
					) : (
						/* ── Provider Catalog & Credentials List ────────────────── */
						<div>
							<p
								style={{
									fontSize: "12px",
									color: "var(--text-secondary)",
									marginBottom: "12px",
									lineHeight: 1.5,
								}}
							>
								Authorize AI provider subscriptions via OAuth or enter BYOK API
								keys. Credentials are encrypted with AES-GCM (256-bit) on your
								account and enable model execution across all bots in this
								family.
							</p>

							<div className="provider-list">
								{allProviderIds.map((providerId) => {
									const known = KNOWN_PROVIDERS.find(
										(p) => p.id === providerId,
									);
									const oauthInfo = oauthProviders.find(
										(p) => p.providerId === providerId,
									);
									const cred = credentials.find(
										(c) => c.providerId === providerId,
									);

									const name = known?.name ?? oauthInfo?.name ?? providerId;
									const icon = known?.icon ?? "🔑";
									const description =
										known?.description ??
										(oauthInfo
											? "OAuth sign-in supported"
											: "API Key provider");
									const supportsOAuth = Boolean(
										oauthInfo || known?.supportsOAuth,
									);
									const loginLabel =
										oauthInfo?.loginLabel ??
										known?.defaultLoginLabel ??
										`Sign in with ${name}`;

									const isConfigured = Boolean(cred);
									const isKeyExpanded = expandedApiKeyProvider === providerId;

									return (
										<div
											key={providerId}
											className={`provider-card ${
												providerId === "xai" ? "provider-card-highlight" : ""
											}`}
										>
											<div className="provider-card-header">
												<div className="provider-info">
													<span className="provider-icon">{icon}</span>
													<div>
														<div
															style={{
																display: "flex",
																alignItems: "center",
																gap: "8px",
															}}
														>
															<span className="provider-name">{name}</span>
															{providerId === "xai" && (
																<span className="badge badge-indigo">
																	Recommended
																</span>
															)}
														</div>
														<span className="provider-desc">{description}</span>
													</div>
												</div>

												{/* Status Badge */}
												<div>
													{isConfigured ? (
														<span className="badge badge-emerald">
															✓{" "}
															{cred?.type === "oauth"
																? "OAuth Active"
																: "API Key Active"}
														</span>
													) : (
														<span className="badge badge-ghost">
															Not configured
														</span>
													)}
												</div>
											</div>

											{/* Action Buttons */}
											<div className="provider-actions">
												{supportsOAuth && (
													<button
														type="button"
														className="btn btn-primary btn-sm"
														onClick={() => void handleStartOAuth(providerId)}
														disabled={isBusy}
													>
														{loginLabel}
													</button>
												)}

												<button
													type="button"
													className="btn btn-secondary btn-sm"
													onClick={() =>
														setExpandedApiKeyProvider((prev) =>
															prev === providerId ? null : providerId,
														)
													}
												>
													{isKeyExpanded
														? "Close Key Form"
														: isConfigured
															? "Change API Key"
															: "Enter API Key"}
												</button>

												{isConfigured && (
													<button
														type="button"
														className="btn btn-ghost btn-sm"
														style={{ color: "var(--accent-rose)" }}
														onClick={() =>
															void handleDeleteCredential(providerId)
														}
														disabled={isBusy}
													>
														Disconnect
													</button>
												)}
											</div>

											{/* Inline API Key Form */}
											{isKeyExpanded && (
												<div className="api-key-inline-form">
													<input
														type="password"
														className="input input-mono"
														style={{
															flex: 1,
															fontSize: "12px",
															height: "30px",
														}}
														placeholder={`Enter ${name} API key...`}
														value={apiKeyInputs[providerId] ?? ""}
														onChange={(e) =>
															setApiKeyInputs((prev) => ({
																...prev,
																[providerId]: e.target.value,
															}))
														}
													/>
													<button
														type="button"
														className="btn btn-primary btn-sm"
														onClick={() => void handleSaveApiKey(providerId)}
														disabled={
															isBusy || !apiKeyInputs[providerId]?.trim()
														}
													>
														Save Key
													</button>
												</div>
											)}
										</div>
									);
								})}
							</div>
						</div>
					)}
				</div>

				{/* Modal Footer */}
				<div className="modal-footer">
					<button
						type="button"
						className="btn btn-secondary"
						onClick={onClose}
						disabled={isBusy}
					>
						Close
					</button>
				</div>
			</div>
		</div>
	);
}
