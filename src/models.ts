import type {
	ApiKeyCredential,
	AssistantMessage,
	AuthContext,
	Credential,
	CredentialInfo,
	CredentialStore,
	JsonObject,
	ModelThinkingLevel,
	OAuthCredential,
	SimpleStreamOptions,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import {
	createModels as createPiModels,
	type Models,
	type MutableModels,
} from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import {
	type FauxProviderHandle,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { CredentialInput, ThinkingLevel } from "./protocol.js";
import type { AdminStore } from "./store/admin-interface.js";
import type { Env } from "./types.js";

registerBunOAuthFlows();

export const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly ModelThinkingLevel[];

export function getSupportedThinkingLevels(model: {
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<string, string | null>>;
}): ThinkingLevel[] {
	if (!model.reasoning) return [];
	const levels: ThinkingLevel[] = [];
	for (const level of THINKING_LEVELS) {
		if (model.thinkingLevelMap) {
			const mapped = model.thinkingLevelMap[level];
			if (mapped === null) continue;
			if (typeof mapped === "string") {
				levels.push(level as ThinkingLevel);
				continue;
			}
		}
		if (
			level === "off" ||
			level === "minimal" ||
			level === "low" ||
			level === "medium" ||
			level === "high"
		) {
			levels.push(level as ThinkingLevel);
		}
	}
	return levels;
}

export function parseModelRef(raw: string, name = "model"): ModelRef {
	const slash = raw.indexOf("/");
	if (slash <= 0 || slash === raw.length - 1) {
		throw new Error(`${name}: expected <provider>/<modelId>, got "${raw}"`);
	}
	return { provider: raw.slice(0, slash), modelId: raw.slice(slash + 1) };
}

export function modelRefString(model: ModelRef): string {
	return `${model.provider}/${model.modelId}`;
}

export function parseThinkingLevel(
	value: string | undefined,
): ModelThinkingLevel | undefined {
	const level = value?.trim();
	if (!level) return undefined;
	return (THINKING_LEVELS as readonly string[]).includes(level)
		? (level as ModelThinkingLevel)
		: undefined;
}

// ─── Credential Store Adapter (Bridges AdminStore BYOK <-> pi-ai) ────────────

export function toPiCredential(input: CredentialInput): Credential {
	if (input.type === "api_key") {
		const cred: ApiKeyCredential = {
			type: "api_key",
			key: input.apiKey,
		};
		return cred;
	}
	const cred: OAuthCredential = {
		type: "oauth",
		access: input.accessToken,
		refresh: input.refreshToken ?? "",
		expires: input.expiresAt ?? Date.now() + 3600_000,
	};
	return cred;
}

export function fromPiCredential(cred: Credential): CredentialInput {
	if (cred.type === "api_key") {
		return {
			type: "api_key",
			apiKey: cred.key ?? "",
		};
	}
	return {
		type: "oauth",
		accessToken: cred.access,
		refreshToken: cred.refresh,
		expiresAt: cred.expires,
	};
}

export interface CredentialCacheEntry {
	cred: Credential;
	expiresAt: number;
}

export class AccountCredentialStore implements CredentialStore {
	private readonly cache = new Map<string, CredentialCacheEntry>();
	private readonly ttlMs: number;

	constructor(
		private readonly adminStore: AdminStore,
		private readonly getAccountId: () => string | undefined,
		options?: { ttlMs?: number },
	) {
		this.ttlMs = options?.ttlMs ?? 5 * 60 * 1000;
	}

	async read(providerId: string): Promise<Credential | undefined> {
		const accountId = this.getAccountId();
		if (!accountId) return undefined;

		const cached = this.cache.get(providerId);
		if (cached && cached.expiresAt > Date.now()) {
			return cached.cred;
		}

		const cred = await this.adminStore.getCredential(accountId, providerId);
		if (cred) {
			this.cache.set(providerId, {
				cred,
				expiresAt: Date.now() + this.ttlMs,
			});
		} else {
			this.cache.delete(providerId);
		}
		return cred;
	}

	invalidate(providerId?: string): void {
		if (providerId) {
			this.cache.delete(providerId);
		} else {
			this.cache.clear();
		}
	}

	getCacheSize(): number {
		return this.cache.size;
	}

	hasCached(providerId: string): boolean {
		const entry = this.cache.get(providerId);
		return Boolean(entry && entry.expiresAt > Date.now());
	}

	async list(): Promise<readonly CredentialInfo[]> {
		const accountId = this.getAccountId();
		if (!accountId) return [];
		const list = await this.adminStore.listCredentials(accountId);
		return list.map((item) => ({
			providerId: item.providerId,
			type: item.type,
		}));
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		this.invalidate(providerId);
		const accountId = this.getAccountId();
		const current = accountId ? await this.read(providerId) : undefined;
		const next = await fn(current);
		if (next && accountId) {
			await this.adminStore.setCredential(accountId, providerId, next);
			this.cache.set(providerId, {
				cred: next,
				expiresAt: Date.now() + this.ttlMs,
			});
		} else if (!next && accountId) {
			this.cache.delete(providerId);
		}
		return next;
	}

	async delete(providerId: string): Promise<void> {
		this.invalidate(providerId);
		const accountId = this.getAccountId();
		if (!accountId) return;
		await this.adminStore.deleteCredential(accountId, providerId);
	}
}

export function createWorkerAuthContext(env: Env): AuthContext {
	return {
		async env(name: string): Promise<string | undefined> {
			const record = env as unknown as Record<string, unknown>;
			const val = record[name];
			return typeof val === "string" && val.length > 0 ? val : undefined;
		},
		async fileExists(): Promise<boolean> {
			return false;
		},
	};
}

// ─── xAI Native Server Tool Rewriting ────────────────────────────────────────

const NATIVE_TOOLS: Readonly<
	Record<string, Readonly<Record<string, { type: string }>>>
> = {
	xai: {
		"web.search": { type: "web_search" },
		"x.search": { type: "x_search" },
		"code.execute": { type: "code_interpreter" },
	},
};

export function unavailableToolMessage(name: string, provider: string): string {
	return `${name} is not available on provider "${provider}"`;
}

function functionName(tool: unknown): string | undefined {
	if (!tool || typeof tool !== "object") return undefined;
	const record = tool as { type?: unknown; name?: unknown };
	if (record.type !== "function" || typeof record.name !== "string") {
		return undefined;
	}
	return record.name;
}

export function attachNativeTools(provider: string, payload: unknown): unknown {
	const native = NATIVE_TOOLS[provider];
	if (
		!native ||
		!payload ||
		typeof payload !== "object" ||
		Array.isArray(payload)
	) {
		return payload;
	}
	const body = payload as { tools?: unknown };
	if (!Array.isArray(body.tools)) return payload;
	const tools: unknown[] = [];
	const added = new Set<string>();
	for (const tool of body.tools) {
		const name = functionName(tool);
		const replacement = name ? native[name] : undefined;
		if (!replacement) {
			tools.push(tool);
			continue;
		}
		if (!added.has(replacement.type)) {
			tools.push(replacement);
			added.add(replacement.type);
		}
	}
	return { ...body, tools };
}

export type ServerToolPart = {
	type: "serverTool";
	id: string;
	name: string;
	arguments: JsonObject;
	status: "done" | "error";
	result?: string;
};

const SERVER_ITEM_TYPES = new Set([
	"web_search_call",
	"x_search_call",
	"code_interpreter_call",
	"file_search_call",
	"mcp_call",
]);

export function noteServerTool(
	found: Map<string, ServerToolPart>,
	event: unknown,
): void {
	if (!event || typeof event !== "object") return;
	const record = event as { item?: unknown; response?: { output?: unknown } };
	if (record.item) collectItem(found, record.item);
	if (Array.isArray(record.response?.output)) {
		for (const item of record.response.output) collectItem(found, item);
	}
}

export function applyServerTools(
	message: AssistantMessage,
	found: ReadonlyMap<string, ServerToolPart>,
): void {
	if (found.size === 0) return;
	(message.content as unknown[]).unshift(...found.values());
}

function collectItem(found: Map<string, ServerToolPart>, item: unknown): void {
	if (!item || typeof item !== "object") return;
	const record = item as {
		id?: unknown;
		type?: unknown;
		name?: unknown;
		status?: unknown;
		action?: unknown;
		result?: unknown;
		output?: unknown;
		error?: unknown;
	};
	if (typeof record.type !== "string" || !SERVER_ITEM_TYPES.has(record.type)) {
		return;
	}
	const name = serverToolName(record.type, record.action, record.name);
	if (!name) return;
	const id =
		typeof record.id === "string" ? record.id : `${record.type}:${name}`;
	const failed = record.status === "failed" || record.error !== undefined;
	const result = serverToolResult(record);
	found.set(id, {
		type: "serverTool",
		id,
		name,
		arguments: serverToolArguments(record.action),
		status: failed ? "error" : "done",
		...(result ? { result } : {}),
	});
}

function serverToolName(
	type: string,
	action: unknown,
	name: unknown,
): string | undefined {
	if (type === "web_search_call") {
		const kind =
			action && typeof action !== "string" && typeof action === "object"
				? (action as { type?: unknown }).type
				: undefined;
		return kind === "open_page" || kind === "find_in_page"
			? "web.fetch"
			: "web.search";
	}
	if (type === "x_search_call") return "x.search";
	if (type === "code_interpreter_call") return "code.execute";
	if (type === "file_search_call") return "collections.search";
	if (type === "mcp_call") return typeof name === "string" ? name : "mcp";
	return undefined;
}

function serverToolArguments(action: unknown): JsonObject {
	if (!action || typeof action !== "object" || Array.isArray(action)) return {};
	return action as JsonObject;
}

function serverToolResult(record: {
	result?: unknown;
	output?: unknown;
	error?: unknown;
}): string | undefined {
	for (const value of [record.result, record.output, record.error]) {
		if (typeof value === "string" && value.trim()) return value;
		if (value && typeof value === "object") return JSON.stringify(value);
	}
	return undefined;
}

// ─── Offline Faux Provider (`faux/echo`) ─────────────────────────────────────

function extractMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (part && typeof part === "object" && "type" in part) {
					const p = part as { type: string; text?: string };
					if (p.type === "text" && typeof p.text === "string") return p.text;
				}
				return "";
			})
			.join("");
	}
	return "";
}

export function lastUserText(context: TranscriptContext): string {
	const user = context.messages.findLast((message) => message.role === "user");
	if (user?.role !== "user") return "";
	return extractMessageText(user.content);
}

export function visibleUserMessages(context: TranscriptContext): number {
	return context.messages.filter((message) => message.role === "user").length;
}

const TOOL_DIRECTIVE_REGEX = /\[tool:([a-zA-Z0-9_.-]+)\s+(\{[\s\S]*?\})\]/;

/**
 * Deterministic offline responder for `faux/echo`.
 * Supports:
 * 1. Standard echo: `echo(<visibleUserMessages>): <lastUserText>`
 * 2. Tool directives in user prompt: `[tool:<toolName> <jsonArgs>]`
 * 3. Harvest fork prompts (`[HARVEST]` prefix): extracts `[remember: <fact>]` or `[learn:<slug> <body...>]`
 * 4. Bot search judge prompts (`[SEARCH_BOT_JUDGE]` prefix): matches query keywords against candidate blocks
 */
export function echoResponse(context: TranscriptContext): AssistantMessage {
	const lastUserIdx = context.messages.findLastIndex(
		(message) => message.role === "user",
	);
	const messagesSinceUser =
		lastUserIdx >= 0 ? context.messages.slice(lastUserIdx + 1) : [];
	const lastToolResult = messagesSinceUser.findLast(
		(message) => message.role === "toolResult",
	);
	const userText = lastUserText(context);
	const userCount = visibleUserMessages(context);

	// 1. If a toolResult occurred after the last user message, summarize it and finish the turn
	// (Even if pi-durable appended a positional system section update after the toolResult)
	if (lastToolResult && lastToolResult.role === "toolResult") {
		const resultText = extractMessageText(lastToolResult.content);
		const cleanedText = userText.replace(/\[think:[^\]]+\]/gi, "").trim();
		return fauxAssistantMessage(
			`echo(${userCount}): ${cleanedText} -> ${resultText}`,
		);
	}

	// 2. Check if this is a SearchBotTask judge call
	if (userText.startsWith("[SEARCH_BOT_JUDGE]")) {
		return handleSearchBotJudge(userText);
	}

	// 2b. Recreate specific offline prompts such as "what can you do?"
	const normalizedUserText = userText.trim().toLowerCase();
	if (
		normalizedUserText === "what can you do?" ||
		normalizedUserText === "what can you do"
	) {
		return fauxAssistantMessage(
			"I can:\n\n- Answer questions, explain things, and chat\n- Search the web and browse pages\n- Search and fetch X (Twitter) posts/users\n- Read, update, and manage my own knowledge files and memory\n- Run Python code (data analysis, math, plotting, etc.)\n- Schedule reminders or recurring tasks\n- Create and talk to other bots in this system\n\nWhat do you want to do?",
		);
	}

	// 3. Check if this is an Idle Harvest forked turn
	if (userText.startsWith("[HARVEST]")) {
		return handleHarvestPrompt(context);
	}

	// 4. Check for explicit `[tool:name {...}]` or `[think:...]` directives in user prompt
	const thinkMatch = /\[think:\s*([^\]]+)\]/i.exec(userText);
	if (thinkMatch?.[1]) {
		const thought = thinkMatch[1].trim();
		const stripped = userText.replace(thinkMatch[0], "").trim();
		const match = TOOL_DIRECTIVE_REGEX.exec(stripped);
		if (match?.[1] && match[2]) {
			try {
				const toolName = match[1];
				const args = JSON.parse(match[2]) as JsonObject;
				return fauxAssistantMessage(
					[
						fauxThinking(thought),
						fauxText(`Calling ${toolName}...`),
						fauxToolCall(toolName, args),
					],
					{ stopReason: "toolUse" },
				);
			} catch {
				// Fall through
			}
		}
		return fauxAssistantMessage([
			fauxThinking(thought),
			fauxText(`echo(${userCount}): ${stripped}`),
		]);
	}

	const match = TOOL_DIRECTIVE_REGEX.exec(userText);
	if (match?.[1] && match[2]) {
		try {
			const toolName = match[1];
			const args = JSON.parse(match[2]) as JsonObject;
			return fauxAssistantMessage(
				[fauxText(`Calling ${toolName}...`), fauxToolCall(toolName, args)],
				{ stopReason: "toolUse" },
			);
		} catch {
			// Fall through to normal echo if JSON is malformed
		}
	}

	return fauxAssistantMessage(`echo(${userCount}): ${userText}`);
}

function handleSearchBotJudge(prompt: string): AssistantMessage {
	// Format includes QUERY: <q> and CANDIDATE <id>: <details>
	const queryMatch = /QUERY:\s*(.+)/i.exec(prompt);
	const query = (queryMatch?.[1] ?? "").toLowerCase();
	const terms = query.split(/[^a-z0-9]+/).filter((t) => t.length >= 2);

	const candidates: { id: string; score: number }[] = [];
	const blocks = prompt.split(/CANDIDATE_BOT:/g).slice(1);
	for (const block of blocks) {
		const idMatch = /^\s*([^\n]+)/.exec(block);
		const id = idMatch?.[1]?.trim();
		if (!id) continue;
		const lower = block.toLowerCase();
		let score = 0;
		for (const term of terms) {
			if (lower.includes(term)) score += 1;
		}
		if (score > 0 || terms.length === 0) {
			candidates.push({ id, score });
		}
	}
	candidates.sort((a, b) => b.score - a.score);
	return fauxAssistantMessage(
		JSON.stringify({ matches: candidates.map((c) => c.id) }),
	);
}

function handleHarvestPrompt(context: TranscriptContext): AssistantMessage {
	// Collect all user messages prior to the `[HARVEST]` prompt
	const priorUsers = context.messages
		.slice(0, -1)
		.filter((m) => m.role === "user")
		.map((m) => extractMessageText(m.content));

	const combined = priorUsers.join("\n");
	if (combined.includes("[no-harvest]")) {
		return fauxAssistantMessage("No durable facts to harvest.");
	}

	const rememberMatch = /\[remember:\s*([^\]]+)\]/i.exec(combined);
	if (rememberMatch?.[1]) {
		const fact = rememberMatch[1].trim();
		return fauxAssistantMessage(
			[
				fauxToolCall("memory_update", {
					content: `- ${fact}\n`,
					expectedVersion: 0,
				}),
			],
			{ stopReason: "toolUse" },
		);
	}

	const learnMatch = /\[learn:([a-z0-9-]+)\s+([^\]]+)\]/i.exec(combined);
	if (learnMatch?.[1] && learnMatch?.[2]) {
		const slug = learnMatch[1].trim();
		const body = learnMatch[2].trim();
		return fauxAssistantMessage(
			[
				fauxToolCall("knowledge_update", {
					slug,
					description: `Learned note on ${slug}`,
					category: "learned",
					body,
					expectedVersion: 0,
				}),
			],
			{ stopReason: "toolUse" },
		);
	}

	// Default harvest behavior when there are prior user messages and no `[no-harvest]`:
	if (priorUsers.length > 0) {
		const latest = priorUsers[priorUsers.length - 1] ?? "";
		if (latest.trim()) {
			return fauxAssistantMessage(
				[
					fauxToolCall("knowledge_update", {
						slug: "session-notes",
						description: "Notes harvested from conversation",
						category: "harvest",
						body: `Harvested summary: ${latest.trim()}\n`,
						expectedVersion: 0,
					}),
				],
				{ stopReason: "toolUse" },
			);
		}
	}

	return fauxAssistantMessage("Nothing to harvest.");
}

export type FauxResponder = (
	context: TranscriptContext,
) => AssistantMessage | Promise<AssistantMessage>;

export function addFauxProvider(
	models: MutableModels,
	respond: FauxResponder = echoResponse,
): FauxProviderHandle {
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

export function createCadmusModels(
	options: {
		credentials?: CredentialStore;
		authContext?: AuthContext;
		fauxResponder?: FauxResponder;
	} = {},
): { models: MutableModels; faux: FauxProviderHandle } {
	const base = createPiModels({
		...(options.credentials ? { credentials: options.credentials } : {}),
		...(options.authContext ? { authContext: options.authContext } : {}),
	});
	base.setProvider(xaiProvider());
	base.setProvider(openaiProvider());
	base.setProvider(anthropicProvider());
	const faux = addFauxProvider(base, options.fauxResponder ?? echoResponse);
	return {
		models: withNativeTools(base),
		faux,
	};
}

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

export async function checkModel(
	models: Models,
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
	let auth: Awaited<ReturnType<MutableModels["getAuth"]>>;
	try {
		auth = await models.getAuth(ref.provider);
	} catch (error) {
		throw new Error(
			`Provider "${ref.provider}" credentials failed: ${(error as Error).message}`,
		);
	}
	if (!auth) {
		throw new Error(
			`Provider "${ref.provider}" has no credentials configured for this account`,
		);
	}
	return auth.source;
}
