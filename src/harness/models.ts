import type {
	AssistantMessage,
	CredentialStore,
	ModelThinkingLevel,
	SimpleStreamOptions,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import type { ModelRef } from "@earendil-works/pi-durable";
import {
	applyServerTools,
	attachNativeTools,
	noteServerTool,
	type ServerToolPart,
} from "../extensions/provider-tools.ts";

export const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const satisfies readonly ModelThinkingLevel[];

/** `provider/modelId`; the model id may itself contain slashes (e.g. `openrouter/anthropic/x`). */
export function parseModelRef(raw: string, name = "model"): ModelRef {
	const slash = raw.indexOf("/");
	if (slash <= 0 || slash === raw.length - 1)
		throw new Error(`${name}: expected <provider>/<modelId>, got "${raw}"`);
	return { provider: raw.slice(0, slash), modelId: raw.slice(slash + 1) };
}

export function modelRefString(model: ModelRef): string {
	return `${model.provider}/${model.modelId}`;
}

/** A stored thinking string, or `undefined` when it is empty or not a level the harness knows. */
export function parseThinkingLevel(
	value: string | undefined,
): ModelThinkingLevel | undefined {
	const level = value?.trim();
	if (!level) return undefined;
	return (THINKING_LEVELS as readonly string[]).includes(level)
		? (level as ModelThinkingLevel)
		: undefined;
}

function lastUserText(context: TranscriptContext): string {
	const user = context.messages.findLast((message) => message.role === "user");
	if (user?.role !== "user") return "";
	return typeof user.content === "string"
		? user.content
		: user.content
				.map((part) => (part.type === "text" ? part.text : ""))
				.join("");
}

/** Number of user messages the model can see: lets tests observe `/new` resets. */
export function visibleUserMessages(context: TranscriptContext): number {
	return context.messages.filter((message) => message.role === "user").length;
}

/** Offline echo model: `echo(<visible user messages>): <last user text>`. */
export function echoResponse(context: TranscriptContext): AssistantMessage {
	return fauxAssistantMessage(
		`echo(${visibleUserMessages(context)}): ${lastUserText(context)}`,
	);
}

export type FauxResponder = (
	context: TranscriptContext,
) => AssistantMessage | Promise<AssistantMessage>;

/** A faux provider ("faux") with an endless supply of `respond` steps. */
export function addFauxProvider(
	models: MutableModels,
	respond: FauxResponder = echoResponse,
) {
	const faux = fauxProvider({
		models: [{ id: "echo", contextWindow: 128_000, maxTokens: 8_192 }],
	});
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
export function createModels(
	options: { credentials?: CredentialStore } = {},
): MutableModels {
	const models = builtinModels(
		options.credentials ? { credentials: options.credentials } : {},
	);
	addFauxProvider(models);
	return withNativeTools(models);
}

/**
 * pi-durable does not forward `onPayload`. Swap catalog functions for the
 * provider's server tools on every simple request, then run a caller's hook.
 */
function withNativeTools(models: MutableModels): MutableModels {
	const streamSimple = models.streamSimple.bind(models);
	const completeSimple = models.completeSimple.bind(models);
	const attach = <
		T extends {
			onPayload?: SimpleStreamOptions["onPayload"];
			onProviderStreamEvent?: SimpleStreamOptions["onProviderStreamEvent"];
		},
	>(
		model: { provider: string },
		options: T | undefined,
		serverTools?: Map<string, ServerToolPart>,
	): T => {
		const previous = options?.onPayload;
		const previousEvent = options?.onProviderStreamEvent;
		return {
			...options,
			onPayload: async (payload, requested) => {
				const rewritten = attachNativeTools(model.provider, payload);
				if (!previous) return rewritten;
				const next = await previous(rewritten, requested);
				return next === undefined ? rewritten : next;
			},
			onProviderStreamEvent: async (event, streamed) => {
				if (serverTools) noteServerTool(serverTools, event);
				await previousEvent?.(event, streamed);
			},
		} as T;
	};
	return new Proxy(models, {
		get(target, prop, receiver) {
			if (prop === "streamSimple") {
				return (
					model: Parameters<MutableModels["streamSimple"]>[0],
					context: Parameters<MutableModels["streamSimple"]>[1],
					options?: Parameters<MutableModels["streamSimple"]>[2],
				) => {
					const serverTools = new Map<string, ServerToolPart>();
					const events = streamSimple(
						model,
						context,
						attach(model, options, serverTools),
					);
					const read = events.result.bind(events);
					events.result = () =>
						read().then((message) => {
							applyServerTools(message, serverTools);
							return message;
						});
					return events;
				};
			}
			if (prop === "completeSimple") {
				return (
					model: Parameters<MutableModels["completeSimple"]>[0],
					context: Parameters<MutableModels["completeSimple"]>[1],
					options?: Parameters<MutableModels["completeSimple"]>[2],
				) => completeSimple(model, context, attach(model, options));
			}
			const value = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/** Fail fast with an actionable message when the configured model is unknown or its provider has no credentials. */
export async function checkModel(
	models: MutableModels,
	ref: ModelRef,
): Promise<string | undefined> {
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
		throw new Error(
			`Provider "${ref.provider}" credentials failed: ${(error as Error).message}. Run: bun run login ${ref.provider}`,
		);
	}
	const oauth = models.getProvider(ref.provider)?.auth.oauth;
	if (!auth)
		throw new Error(
			`Provider "${ref.provider}" has no credentials: set its API key env var (e.g. ${ref.provider.toUpperCase().replace(/-/g, "_")}_API_KEY)${oauth ? ` or run: bun run login ${ref.provider}` : ""}`,
		);
	return auth.source;
}
