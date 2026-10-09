import type { AssistantMessage, CredentialStore, ModelThinkingLevel, TranscriptContext } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { ModelRef } from "@earendil-works/pi-durable";

/**
 * Model choice is env-driven and not decided yet. `main` drives chat conversations; `reviewer` and `gate` are
 * reserved for the learning loop (Phase 4) and memory capture gate.
 */
export type ModelConfig = {
	readonly main: ModelRef;
	readonly thinkingLevel?: ModelThinkingLevel;
	readonly reviewer?: ModelRef;
	readonly gate?: ModelRef;
};

const THINKING: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"] as ModelThinkingLevel[];

/** `provider/modelId`; the model id may itself contain slashes (e.g. `openrouter/anthropic/x`). */
export function parseModelRef(raw: string, name = "model"): ModelRef {
	const slash = raw.indexOf("/");
	if (slash <= 0 || slash === raw.length - 1) throw new Error(`${name}: expected <provider>/<modelId>, got "${raw}"`);
	return { provider: raw.slice(0, slash), modelId: raw.slice(slash + 1) };
}

export function modelRefString(model: ModelRef): string {
	return `${model.provider}/${model.modelId}`;
}

/** A stored thinking string, or `undefined` when it is empty or not a level the harness knows. */
export function parseThinkingLevel(value: string | undefined): ModelThinkingLevel | undefined {
	const level = value?.trim();
	if (!level) return undefined;
	return (THINKING as readonly string[]).includes(level) ? (level as ModelThinkingLevel) : undefined;
}

export function modelConfigFromEnv(env: NodeJS.ProcessEnv): ModelConfig {
	const main = env.PI_MODEL?.trim();
	if (!main) throw new Error("PI_MODEL is required (<provider>/<modelId>, or faux/echo for an offline smoke test)");
	const thinking = env.PI_THINKING_LEVEL?.trim() as ModelThinkingLevel | undefined;
	if (thinking && !THINKING.includes(thinking)) throw new Error(`PI_THINKING_LEVEL: unknown level "${thinking}"`);
	return {
		main: parseModelRef(main, "PI_MODEL"),
		...(thinking ? { thinkingLevel: thinking } : {}),
		...(env.PI_REVIEW_MODEL ? { reviewer: parseModelRef(env.PI_REVIEW_MODEL, "PI_REVIEW_MODEL") } : {}),
		...(env.PI_GATE_MODEL ? { gate: parseModelRef(env.PI_GATE_MODEL, "PI_GATE_MODEL") } : {}),
	};
}

function lastUserText(context: TranscriptContext): string {
	const user = context.messages.findLast((message) => message.role === "user");
	if (!user || user.role !== "user") return "";
	return typeof user.content === "string"
		? user.content
		: user.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** Number of user messages the model can see: lets tests observe `/new` resets. */
export function visibleUserMessages(context: TranscriptContext): number {
	return context.messages.filter((message) => message.role === "user").length;
}

/** Offline echo model: `echo(<visible user messages>): <last user text>`. */
export function echoResponse(context: TranscriptContext): AssistantMessage {
	return fauxAssistantMessage(`echo(${visibleUserMessages(context)}): ${lastUserText(context)}`);
}

export type FauxResponder = (context: TranscriptContext) => AssistantMessage | Promise<AssistantMessage>;

/** A faux provider ("faux") with an endless supply of `respond` steps. */
export function addFauxProvider(models: MutableModels, respond: FauxResponder = echoResponse) {
	const faux = fauxProvider({ models: [{ id: "echo", contextWindow: 128_000, maxTokens: 8_192 }] });
	const step: FauxResponseStep = (context) => {
		faux.appendResponses([step]);
		return respond(context);
	};
	faux.setResponses([step]);
	models.setProvider(faux.provider);
	return faux;
}

/**
 * Every pi-ai built-in provider plus the offline `faux/echo` model. Auth per provider: a stored credential in
 * `credentials` (OAuth from `bun run login`, refreshed automatically by pi-ai) wins; otherwise the provider's API-key env
 * var (e.g. `XAI_API_KEY`).
 */
export function createModels(options: { credentials?: CredentialStore } = {}): MutableModels {
	const models = builtinModels(options.credentials ? { credentials: options.credentials } : {});
	addFauxProvider(models);
	return models;
}

/** Fail fast with an actionable message when the configured model is unknown or its provider has no credentials. */
export async function checkModel(models: MutableModels, ref: ModelRef): Promise<string | undefined> {
	if (!models.getModel(ref.provider, ref.modelId)) {
		const known = models.getModels(ref.provider).map((model) => model.id);
		throw new Error(
			known.length
				? `Unknown model ${ref.provider}/${ref.modelId}. Known for ${ref.provider}: ${known.slice(0, 20).join(", ")}${known.length > 20 ? ", …" : ""}`
				: `Unknown provider "${ref.provider}"`,
		);
	}
	if (ref.provider === "faux") return "offline";
	// Resolves (and if needed refreshes) a stored OAuth credential, else the provider's API-key env var.
	let auth: Awaited<ReturnType<MutableModels["getAuth"]>>;
	try {
		auth = await models.getAuth(ref.provider);
	} catch (error) {
		throw new Error(`Provider "${ref.provider}" credentials failed: ${(error as Error).message}. Run: bun run login ${ref.provider}`);
	}
	const oauth = models.getProvider(ref.provider)?.auth.oauth;
	if (!auth)
		throw new Error(
			`Provider "${ref.provider}" has no credentials: set its API key env var (e.g. ${ref.provider.toUpperCase().replace(/-/g, "_")}_API_KEY)${oauth ? ` or run: bun run login ${ref.provider}` : ""}`,
		);
	return auth.source;
}
