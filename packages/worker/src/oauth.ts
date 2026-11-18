import type {
	AuthEvent,
	AuthPrompt,
	Models,
	OAuthCredential,
	ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import { getLogger } from "./log.js";
import type {
	AccountEvent,
	AccountOAuthEvent,
	OAuthFlowRecord,
	OAuthProviderInfo,
} from "./protocol.js";
import type { AdminStore } from "./store/admin-interface.js";

export function inferFlowType(
	providerId: string,
): "device_code" | "browser_code" | "interactive" {
	const lower = providerId.toLowerCase();
	if (["xai", "meta", "github-copilot", "github"].includes(lower)) {
		return "device_code";
	}
	if (
		[
			"anthropic",
			"openai-codex",
			"openai-chatgpt",
			"openrouter",
			"kimi-coding",
		].includes(lower)
	) {
		return "browser_code";
	}
	return "interactive";
}

interface ActiveFlow {
	record: OAuthFlowRecord;
	accountId: string;
	providerId: string;
	abortController: AbortController;
	pendingPrompt?: {
		resolve: (value: string) => void;
		reject: (err: Error) => void;
	};
	promise: Promise<void>;
}

export class OAuthFlowManager {
	private readonly flows = new Map<string, ActiveFlow>();

	constructor(
		private readonly adminStore: AdminStore,
		private readonly getModels: () => Models,
		private readonly broadcast: (
			event: AccountOAuthEvent | AccountEvent,
		) => void,
		private readonly onCredentialChanged?: (
			accountId: string,
			providerId: string,
		) => Promise<void>,
	) {}

	listProviders(): OAuthProviderInfo[] {
		const models = this.getModels();
		const providers = models.getProviders();
		const result: OAuthProviderInfo[] = [];

		for (const p of providers) {
			if (p.auth.oauth) {
				result.push({
					providerId: p.id,
					name: p.auth.oauth.name ?? p.name ?? p.id,
					flowType: inferFlowType(p.id),
					loginLabel: p.auth.oauth.loginLabel,
					isSubscription: p.auth.oauth.isSubscription,
				});
			}
		}
		return result;
	}

	async startFlow(options: {
		accountId: string;
		providerId: string;
		redirectUri?: string;
	}): Promise<{ record: OAuthFlowRecord; backgroundPromise: Promise<void> }> {
		this.cleanupOldFlows();
		const { accountId, providerId } = options;
		const models = this.getModels();
		const provider = models.getProvider(providerId);

		if (!provider) {
			throw new Error(`Provider "${providerId}" not found`);
		}
		if (!provider.auth.oauth?.login) {
			throw new Error(`Provider "${providerId}" does not support OAuth login`);
		}

		const flowId = `oauth_${crypto.randomUUID().slice(0, 12)}`;
		const abortController = new AbortController();

		const record: OAuthFlowRecord = {
			flowId,
			providerId,
			flowType: inferFlowType(providerId),
			status: "pending",
			updatedAt: Date.now(),
		};

		let initialResolved = false;
		let resolveInitial: () => void;
		const initialWait = new Promise<void>((resolve) => {
			resolveInitial = resolve;
		});

		const activeFlow: ActiveFlow = {
			record,
			accountId,
			providerId,
			abortController,
			promise: Promise.resolve(),
		};

		const interaction: ProviderAuthInteraction = {
			signal: abortController.signal,
			notify: (event: AuthEvent) => {
				record.updatedAt = Date.now();
				if (event.type === "device_code") {
					record.flowType = "device_code";
					record.userCode = event.userCode;
					try {
						const parsed = new URL(event.verificationUri);
						record.verificationUriComplete = event.verificationUri;
						record.verificationUri = `${parsed.origin}${parsed.pathname}`;
					} catch {
						record.verificationUri = event.verificationUri;
						record.verificationUriComplete = event.verificationUri;
					}
					record.intervalSeconds = event.intervalSeconds ?? 5;
					if (event.expiresInSeconds) {
						record.expiresAt = Date.now() + event.expiresInSeconds * 1000;
					}
					record.message = `Open ${record.verificationUri} and enter code: ${event.userCode}`;
					if (!initialResolved) {
						initialResolved = true;
						resolveInitial();
					}
				} else if (event.type === "auth_url") {
					record.flowType = "browser_code";
					record.authorizationUrl = event.url;
					record.message =
						event.instructions ??
						`Open ${event.url} in your browser to sign in`;
					if (!initialResolved) {
						initialResolved = true;
						resolveInitial();
					}
				} else if (event.type === "progress") {
					record.status = "progress";
					record.message = event.message;
				} else if (event.type === "info") {
					record.message = event.message;
				}
				this.emitFlowEvent(record);
			},
			prompt: async (prompt: AuthPrompt): Promise<string> => {
				record.status = "prompt";
				record.prompt = {
					type: prompt.type,
					message: prompt.message,
					placeholder: "placeholder" in prompt ? prompt.placeholder : undefined,
					options:
						"options" in prompt
							? prompt.options.map((o) => ({
									id: o.id,
									label: o.label,
									description: o.description,
								}))
							: undefined,
				};
				record.updatedAt = Date.now();
				this.emitFlowEvent(record);

				if (!initialResolved) {
					initialResolved = true;
					resolveInitial();
				}

				return new Promise<string>((resolve, reject) => {
					activeFlow.pendingPrompt = { resolve, reject };
				});
			},
		};

		const runLogin = async (): Promise<void> => {
			const log = getLogger().child({
				account: accountId,
				provider: providerId,
				flowId,
			});
			log.info("oauth flow started");

			try {
				const oauth = provider.auth.oauth;
				if (!oauth) {
					throw new Error(
						`OAuth provider '${providerId}' does not have an oauth handler configured`,
					);
				}
				const cred: OAuthCredential = await oauth.login(interaction, {
					agentName: "cadmus",
				});

				const summary = await this.adminStore.setCredential(
					accountId,
					providerId,
					cred,
				);
				if (this.onCredentialChanged) {
					await this.onCredentialChanged(accountId, providerId);
				}

				record.status = "completed";
				record.credential = summary;
				record.message = `Successfully authenticated with ${provider.name ?? providerId}`;
				record.updatedAt = Date.now();
				this.emitFlowEvent(record);

				this.broadcast({
					type: "account.event",
					payload: {
						accountId,
						action: "credential.set",
						providerId,
						when: Date.now(),
					},
				});

				log.info("oauth flow completed successfully");
			} catch (err: unknown) {
				if (abortController.signal.aborted) {
					record.status = "cancelled";
					record.message = "OAuth login was cancelled";
					log.info("oauth flow cancelled");
				} else {
					const message = err instanceof Error ? err.message : String(err);
					record.status = "failed";
					record.error = {
						code: "oauth_failed",
						message,
					};
					record.message = message;
					log.warn("oauth flow failed", { error: err });
				}
				record.updatedAt = Date.now();
				this.emitFlowEvent(record);
			} finally {
				activeFlow.pendingPrompt = undefined;
			}
		};

		const backgroundPromise = runLogin();
		activeFlow.promise = backgroundPromise;
		this.flows.set(flowId, activeFlow);

		// Wait until either the initial interaction event fires, the flow finishes, or timeout
		await Promise.race([
			initialWait,
			backgroundPromise,
			new Promise((resolve) => setTimeout(resolve, 8_000)),
		]);

		return {
			record: { ...record },
			backgroundPromise,
		};
	}

	getStatus(flowId: string): OAuthFlowRecord {
		const flow = this.flows.get(flowId);
		if (!flow) {
			throw new Error(`OAuth flow "${flowId}" not found`);
		}
		return { ...flow.record };
	}

	submitInput(flowId: string, input: string): OAuthFlowRecord {
		const flow = this.flows.get(flowId);
		if (!flow) {
			throw new Error(`OAuth flow "${flowId}" not found`);
		}
		if (!flow.pendingPrompt) {
			throw new Error(`OAuth flow "${flowId}" is not waiting for input`);
		}
		const pending = flow.pendingPrompt;
		flow.pendingPrompt = undefined;
		flow.record.status = "progress";
		flow.record.prompt = undefined;
		flow.record.updatedAt = Date.now();
		pending.resolve(input);
		return { ...flow.record };
	}

	cancelFlow(flowId: string): OAuthFlowRecord {
		const flow = this.flows.get(flowId);
		if (!flow) {
			throw new Error(`OAuth flow "${flowId}" not found`);
		}
		flow.abortController.abort();
		if (flow.pendingPrompt) {
			flow.pendingPrompt.reject(new Error("OAuth flow cancelled"));
			flow.pendingPrompt = undefined;
		}
		flow.record.status = "cancelled";
		flow.record.updatedAt = Date.now();
		this.emitFlowEvent(flow.record);
		return { ...flow.record };
	}

	private emitFlowEvent(record: OAuthFlowRecord): void {
		this.broadcast({
			type: "account.credentials.oauth.event",
			payload: { ...record },
		});
	}

	private cleanupOldFlows(): void {
		const now = Date.now();
		const MAX_AGE_MS = 15 * 60 * 1000;
		for (const [id, flow] of this.flows.entries()) {
			if (
				(flow.record.status === "completed" ||
					flow.record.status === "cancelled" ||
					flow.record.status === "failed") &&
				now - flow.record.updatedAt > MAX_AGE_MS
			) {
				this.flows.delete(id);
			}
		}
	}
}
