import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type JsonObject,
	type Message,
	type SystemMessage,
	type Tool,
	type ToolCall,
	type ToolResultMessage,
	type TSchema,
	Type,
} from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";

export type ToolDialect = "anthropic" | "google" | "canonical";

export function resolveToolDialect(
	provider: string | null | undefined,
): ToolDialect {
	if (provider === "anthropic") return "anthropic";
	if (provider === "google" || provider === "google-vertex") return "google";
	return "canonical";
}

interface ToolLocalizationSpec {
	readonly canonicalName: string;
	readonly localizedName: string;
	readonly parameters?: TSchema;
	readonly localizeDescription?: (canonicalDescription: string) => string;
	readonly toProviderArgs: (args: JsonObject) => JsonObject;
	readonly fromProviderArgs: (args: JsonObject) => JsonObject;
}

function renameKey(
	obj: JsonObject,
	from: string,
	to: string,
	fallbackFrom?: string,
): JsonObject {
	const value = obj[from] ?? (fallbackFrom ? obj[fallbackFrom] : undefined);
	if (value === undefined && !(from in obj)) {
		return obj;
	}
	const out: JsonObject = {};
	for (const [k, v] of Object.entries(obj)) {
		if (k === from || (fallbackFrom && k === fallbackFrom)) continue;
		out[k] = v;
	}
	if (value !== undefined) {
		out[to] = value;
	}
	return out;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function makeEditArgsTranslators(
	oldKey: string,
	newKey: string,
	pathKey: string,
) {
	return {
		toProviderArgs(args: JsonObject): JsonObject {
			const pathVal = args.path ?? args[pathKey];
			const out: JsonObject = {};
			if (pathVal !== undefined) out[pathKey] = pathVal;
			if (Array.isArray(args.edits)) {
				if (args.edits.length === 1) {
					const single = args.edits[0];
					if (single && typeof single === "object" && !Array.isArray(single)) {
						const rec = single as JsonObject;
						if (rec.oldText !== undefined) out[oldKey] = rec.oldText;
						if (rec.newText !== undefined) out[newKey] = rec.newText;
						return out;
					}
				}
				out.edits = args.edits.map((item) => {
					if (!item || typeof item !== "object" || Array.isArray(item)) {
						return item;
					}
					const rec = item as JsonObject;
					const mapped: JsonObject = {};
					if (rec.oldText !== undefined) mapped[oldKey] = rec.oldText;
					if (rec.newText !== undefined) mapped[newKey] = rec.newText;
					return mapped;
				});
				return out;
			}
			for (const [k, v] of Object.entries(args)) {
				if (k !== "path" && k !== pathKey) out[k] = v;
			}
			return out;
		},
		fromProviderArgs(args: JsonObject): JsonObject {
			const pathVal = args[pathKey] ?? args.path;
			const out: JsonObject = {};
			if (pathVal !== undefined) out.path = pathVal;

			if (Array.isArray(args.edits)) {
				out.edits = args.edits.map((item) => {
					if (!item || typeof item !== "object" || Array.isArray(item)) {
						return item;
					}
					const rec = item as JsonObject;
					const oldText =
						rec.oldText ?? rec[oldKey] ?? rec.old_string ?? rec.old_text;
					const newText =
						rec.newText ?? rec[newKey] ?? rec.new_string ?? rec.new_text;
					const mapped: JsonObject = {};
					if (oldText !== undefined) mapped.oldText = oldText;
					if (newText !== undefined) mapped.newText = newText;
					return mapped;
				});
				return out;
			}

			const oldText =
				args[oldKey] ?? args.old_string ?? args.old_text ?? args.oldText;
			const newText =
				args[newKey] ?? args.new_string ?? args.new_text ?? args.newText;
			if (oldText !== undefined || newText !== undefined) {
				const editEntry: JsonObject = {};
				if (oldText !== undefined) editEntry.oldText = oldText;
				if (newText !== undefined) editEntry.newText = newText;
				out.edits = [editEntry];
				return out;
			}
			return args;
		},
	};
}

const anthropicEditTranslators = makeEditArgsTranslators(
	"old_string",
	"new_string",
	"file_path",
);
const googleEditTranslators = makeEditArgsTranslators(
	"old_text",
	"new_text",
	"path",
);

const identityArgs = (args: JsonObject): JsonObject => args;

const ANTHROPIC_SPECS: readonly ToolLocalizationSpec[] = [
	{
		canonicalName: "read",
		localizedName: "Read",
		parameters: Type.Object({
			file_path: Type.String({
				description:
					"Path to the file to read (virtual /.cadmus/... or workspace path).",
			}),
			offset: Type.Optional(
				Type.Number({
					description: "1-indexed line number to start reading from.",
				}),
			),
			limit: Type.Optional(
				Type.Number({ description: "Maximum number of lines to read." }),
			),
		}),
		toProviderArgs: (args) => renameKey(args, "path", "file_path"),
		fromProviderArgs: (args) => renameKey(args, "file_path", "path"),
	},
	{
		canonicalName: "write",
		localizedName: "Write",
		parameters: Type.Object({
			file_path: Type.String({
				description:
					"Path to the file to write (virtual /.cadmus/... or workspace path).",
			}),
			content: Type.String({ description: "Content to write to the file." }),
		}),
		toProviderArgs: (args) => renameKey(args, "path", "file_path"),
		fromProviderArgs: (args) => renameKey(args, "file_path", "path"),
	},
	{
		canonicalName: "edit",
		localizedName: "Edit",
		parameters: Type.Object({
			file_path: Type.String({
				description:
					"Path to the file to edit (virtual /.cadmus/... or workspace path).",
			}),
			old_string: Type.String({
				description:
					"Exact text to replace (must match a unique location in the file).",
			}),
			new_string: Type.String({ description: "Replacement text." }),
		}),
		localizeDescription: (desc) =>
			desc.replace(
				"Every edits[].oldText must match a unique, non-overlapping region of the original file.",
				"old_string must match a unique region of the original file.",
			),
		...anthropicEditTranslators,
	},
	{
		canonicalName: "delete",
		localizedName: "Delete",
		parameters: Type.Object({
			file_path: Type.String({
				description:
					"Path to the file to delete (e.g. '/.cadmus/skills/<slug>/SKILL.md' or a workspace path).",
			}),
			recursive: Type.Optional(
				Type.Boolean({
					description:
						"For workspace directories only: remove recursively when true.",
				}),
			),
		}),
		toProviderArgs: (args) => renameKey(args, "path", "file_path"),
		fromProviderArgs: (args) => renameKey(args, "file_path", "path"),
	},
	{
		canonicalName: "ls",
		localizedName: "LS",
		toProviderArgs: identityArgs,
		fromProviderArgs: identityArgs,
	},
	{
		canonicalName: "find",
		localizedName: "Glob",
		toProviderArgs: identityArgs,
		fromProviderArgs: identityArgs,
	},
	{
		canonicalName: "grep",
		localizedName: "Grep",
		parameters: Type.Object({
			pattern: Type.String({
				description: "Regular expression or literal string to search for.",
			}),
			path: Type.Optional(
				Type.String({
					description:
						"Optional file or directory path to restrict search (e.g. '/.cadmus/skills' or a workspace path).",
				}),
			),
			glob: Type.Optional(
				Type.String({
					description:
						"Optional glob filter for matching file paths (e.g. '*.md').",
				}),
			),
			ignore_case: Type.Optional(
				Type.Boolean({
					description: "Perform case-insensitive matching when true.",
				}),
			),
			literal: Type.Optional(
				Type.Boolean({
					description:
						"Treat pattern as a literal string rather than a regex when true.",
				}),
			),
			head_limit: Type.Optional(
				Type.Number({
					description:
						"Maximum number of matching lines to return (default 50, max 200).",
				}),
			),
		}),
		toProviderArgs(args) {
			let next = renameKey(args, "ignoreCase", "ignore_case");
			next = renameKey(next, "limit", "head_limit");
			return next;
		},
		fromProviderArgs(args) {
			let next = renameKey(args, "ignore_case", "ignoreCase", "-i");
			next = renameKey(next, "head_limit", "limit");
			return next;
		},
	},
	{
		canonicalName: "bash",
		localizedName: "Bash",
		toProviderArgs: identityArgs,
		fromProviderArgs: identityArgs,
	},
];

const GOOGLE_SPECS: readonly ToolLocalizationSpec[] = [
	{
		canonicalName: "read",
		localizedName: "read_file",
		toProviderArgs: identityArgs,
		fromProviderArgs: identityArgs,
	},
	{
		canonicalName: "write",
		localizedName: "write_file",
		toProviderArgs: identityArgs,
		fromProviderArgs: identityArgs,
	},
	{
		canonicalName: "edit",
		localizedName: "edit_file",
		parameters: Type.Object({
			path: Type.String({
				description:
					"Path to the file to edit (virtual /.cadmus/... or workspace path).",
			}),
			old_text: Type.String({
				description:
					"Exact text to replace (must match a unique location in the file).",
			}),
			new_text: Type.String({ description: "Replacement text." }),
		}),
		localizeDescription: (desc) =>
			desc.replace(
				"Every edits[].oldText must match a unique, non-overlapping region of the original file.",
				"old_text must match a unique region of the original file.",
			),
		...googleEditTranslators,
	},
	{
		canonicalName: "delete",
		localizedName: "delete_file",
		toProviderArgs: identityArgs,
		fromProviderArgs: identityArgs,
	},
	{
		canonicalName: "ls",
		localizedName: "list_directory",
		toProviderArgs: identityArgs,
		fromProviderArgs: identityArgs,
	},
	{
		canonicalName: "find",
		localizedName: "glob",
		toProviderArgs: identityArgs,
		fromProviderArgs: identityArgs,
	},
	{
		canonicalName: "grep",
		localizedName: "grep_search",
		parameters: Type.Object({
			query: Type.String({
				description: "Regular expression or literal string to search for.",
			}),
			path: Type.Optional(
				Type.String({
					description:
						"Optional file or directory path to restrict search (e.g. '/.cadmus/skills' or a workspace path).",
				}),
			),
			glob: Type.Optional(
				Type.String({
					description:
						"Optional glob filter for matching file paths (e.g. '*.md').",
				}),
			),
			ignore_case: Type.Optional(
				Type.Boolean({
					description: "Perform case-insensitive matching when true.",
				}),
			),
			literal: Type.Optional(
				Type.Boolean({
					description:
						"Treat query as a literal string rather than a regex when true.",
				}),
			),
			limit: Type.Optional(
				Type.Number({
					description:
						"Maximum number of matching lines to return (default 50, max 200).",
				}),
			),
		}),
		toProviderArgs(args) {
			let next = renameKey(args, "pattern", "query");
			next = renameKey(next, "ignoreCase", "ignore_case");
			return next;
		},
		fromProviderArgs(args) {
			let next = renameKey(args, "query", "pattern");
			next = renameKey(next, "ignore_case", "ignoreCase");
			return next;
		},
	},
	{
		canonicalName: "bash",
		localizedName: "run_shell_command",
		toProviderArgs: identityArgs,
		fromProviderArgs: identityArgs,
	},
];

interface DialectMaps {
	byCanonical: Map<string, ToolLocalizationSpec>;
	byLocalized: Map<string, ToolLocalizationSpec>;
}

function buildMaps(specs: readonly ToolLocalizationSpec[]): DialectMaps {
	const byCanonical = new Map<string, ToolLocalizationSpec>();
	const byLocalized = new Map<string, ToolLocalizationSpec>();
	for (const spec of specs) {
		byCanonical.set(spec.canonicalName, spec);
		byLocalized.set(spec.localizedName, spec);
		byLocalized.set(spec.localizedName.toLowerCase(), spec);
	}
	return { byCanonical, byLocalized };
}

const DIALECT_MAPS: Record<Exclude<ToolDialect, "canonical">, DialectMaps> = {
	anthropic: buildMaps(ANTHROPIC_SPECS),
	google: buildMaps(GOOGLE_SPECS),
};

function getDialectMaps(
	provider: string | null | undefined,
): DialectMaps | undefined {
	const dialect = resolveToolDialect(provider);
	if (dialect === "canonical") return undefined;
	return DIALECT_MAPS[dialect];
}

function findSpecByLocalized(
	maps: DialectMaps,
	name: string,
): ToolLocalizationSpec | undefined {
	return maps.byLocalized.get(name) ?? maps.byLocalized.get(name.toLowerCase());
}

/**
 * Returns the provider-localized name for a canonical tool name.
 */
export function localizeToolName(
	provider: string | null | undefined,
	canonicalName: string,
): string {
	const maps = getDialectMaps(provider);
	if (!maps) return canonicalName;
	return maps.byCanonical.get(canonicalName)?.localizedName ?? canonicalName;
}

function localizeToolDeclaration(maps: DialectMaps, tool: Tool): Tool {
	const spec = maps.byCanonical.get(tool.name);
	if (!spec) return tool;
	const description = spec.localizeDescription
		? spec.localizeDescription(tool.description)
		: tool.description;
	return {
		...tool,
		name: spec.localizedName,
		description,
		parameters: spec.parameters ?? tool.parameters,
	};
}

function localizeSystemMessage(
	maps: DialectMaps,
	message: SystemMessage,
): SystemMessage {
	let changed = false;
	const toolsAdded = message.toolsAdded?.map((tool) => {
		const next = localizeToolDeclaration(maps, tool);
		if (next !== tool) changed = true;
		return next;
	});
	const toolsRemoved = message.toolsRemoved?.map((ref) => {
		const spec = maps.byCanonical.get(ref.name);
		if (!spec) return ref;
		changed = true;
		return { ...ref, name: spec.localizedName };
	});
	if (!changed) return message;
	return {
		...message,
		...(toolsAdded !== undefined ? { toolsAdded } : {}),
		...(toolsRemoved !== undefined ? { toolsRemoved } : {}),
	};
}

function localizeToolCall(maps: DialectMaps, call: ToolCall): ToolCall {
	const spec = maps.byCanonical.get(call.name);
	if (!spec) return call;
	const nextArgs = spec.toProviderArgs(call.arguments);
	if (spec.localizedName === call.name && nextArgs === call.arguments) {
		return call;
	}
	return {
		...call,
		name: spec.localizedName,
		arguments: nextArgs,
	};
}

function normalizeToolCall(maps: DialectMaps, call: ToolCall): ToolCall {
	const spec =
		findSpecByLocalized(maps, call.name) ?? maps.byCanonical.get(call.name);
	if (!spec) return call;
	const nextArgs = spec.fromProviderArgs(call.arguments);
	if (spec.canonicalName === call.name && nextArgs === call.arguments) {
		return call;
	}
	return {
		...call,
		name: spec.canonicalName,
		arguments: nextArgs,
	};
}

function mapAssistantToolCalls(
	message: AssistantMessage,
	mapper: (call: ToolCall) => ToolCall,
): AssistantMessage {
	let changed = false;
	const content = message.content.map((part) => {
		if (part.type !== "toolCall") return part;
		const next = mapper(part);
		if (next !== part) changed = true;
		return next;
	});
	return changed ? { ...message, content } : message;
}

function localizeToolResultMessage(
	maps: DialectMaps,
	message: ToolResultMessage,
): ToolResultMessage {
	const spec = maps.byCanonical.get(message.toolName);
	if (!spec || spec.localizedName === message.toolName) return message;
	return { ...message, toolName: spec.localizedName };
}

/**
 * Outbound translation: rewrite tool declarations and historical tool calls/results
 * into the target provider's localized convention.
 */
export function localizeTranscriptContext<
	T extends { messages: Message[]; tools?: Tool[] },
>(provider: string | null | undefined, context: T): T {
	const maps = getDialectMaps(provider);
	if (!maps) return context;

	let changed = false;
	const tools = context.tools?.map((tool) => {
		const next = localizeToolDeclaration(maps, tool);
		if (next !== tool) changed = true;
		return next;
	});

	const messages = context.messages.map((message) => {
		if (message.role === "system") {
			const next = localizeSystemMessage(maps, message);
			if (next !== message) changed = true;
			return next;
		}
		if (message.role === "assistant") {
			const next = mapAssistantToolCalls(message, (call) =>
				localizeToolCall(maps, call),
			);
			if (next !== message) changed = true;
			return next;
		}
		if (message.role === "toolResult") {
			const next = localizeToolResultMessage(maps, message);
			if (next !== message) changed = true;
			return next;
		}
		return message;
	});

	if (!changed) return context;
	return {
		...context,
		...(tools !== undefined ? { tools } : {}),
		messages,
	};
}

/**
 * Inbound translation: normalize provider-localized tool calls back to
 * canonical Cadmus tool names and argument shapes.
 */
export function normalizeAssistantMessage(
	provider: string | null | undefined,
	message: AssistantMessage,
): AssistantMessage {
	const maps = getDialectMaps(provider);
	if (!maps) return message;
	return mapAssistantToolCalls(message, (call) =>
		normalizeToolCall(maps, call),
	);
}

function normalizeStreamEvent(
	provider: string,
	event: AssistantMessageEvent,
): AssistantMessageEvent {
	const maps = getDialectMaps(provider);
	if (!maps) return event;

	if (event.type === "done") {
		const message = normalizeAssistantMessage(provider, event.message);
		return message === event.message ? event : { ...event, message };
	}
	if (event.type === "error") {
		const error = normalizeAssistantMessage(provider, event.error);
		return error === event.error ? event : { ...event, error };
	}
	if (event.type === "toolcall_end") {
		const toolCall = normalizeToolCall(maps, event.toolCall);
		const partial = normalizeAssistantMessage(provider, event.partial);
		if (toolCall === event.toolCall && partial === event.partial) return event;
		return { ...event, toolCall, partial };
	}
	if ("partial" in event) {
		const partial = normalizeAssistantMessage(provider, event.partial);
		return partial === event.partial ? event : { ...event, partial };
	}
	return event;
}

/**
 * Wrap an AssistantMessageEventStream to normalize inbound tool calls on all
 * streamed partials, toolcall_end events, done/error events, and `.result()`.
 */
export function wrapLocalizedEventStream(
	provider: string,
	upstream: AssistantMessageEventStream,
): AssistantMessageEventStream {
	if (resolveToolDialect(provider) === "canonical") return upstream;
	const out = createAssistantMessageEventStream();
	let pumpError: unknown;
	const pumpDone = (async () => {
		try {
			for await (const event of upstream) {
				out.push(normalizeStreamEvent(provider, event));
			}
			const finalMessage = await upstream.result();
			out.end(normalizeAssistantMessage(provider, finalMessage));
		} catch (error) {
			pumpError = error;
			out.end();
		}
	})();

	const origResult = out.result.bind(out);
	const origIter = out[Symbol.asyncIterator].bind(out);
	out.result = async () => {
		await pumpDone;
		if (pumpError !== undefined) throw pumpError;
		return origResult();
	};
	out[Symbol.asyncIterator] = async function* () {
		const iter = origIter();
		while (true) {
			const step = await iter.next();
			if (step.done) break;
			yield step.value;
		}
		await pumpDone;
		if (pumpError !== undefined) throw pumpError;
	};
	return out;
}

/**
 * Wrap a `MutableModels` instance so all provider requests translate tool
 * declarations and transcript history outbound and normalize tool calls inbound.
 */
export function withToolLocalization(models: MutableModels): MutableModels {
	const streamSimple = models.streamSimple.bind(models);
	const completeSimple = models.completeSimple.bind(models);
	const fetchDeferred = models.fetchDeferred?.bind(models);

	return new Proxy(models, {
		get(target, prop, receiver) {
			if (prop === "streamSimple") {
				return (
					model: Parameters<MutableModels["streamSimple"]>[0],
					context: Parameters<MutableModels["streamSimple"]>[1],
					options?: Parameters<MutableModels["streamSimple"]>[2],
				) => {
					const localized = localizeTranscriptContext(model.provider, context);
					const events = streamSimple(model, localized, options);
					return wrapLocalizedEventStream(model.provider, events);
				};
			}
			if (prop === "completeSimple") {
				return async (
					model: Parameters<MutableModels["completeSimple"]>[0],
					context: Parameters<MutableModels["completeSimple"]>[1],
					options?: Parameters<MutableModels["completeSimple"]>[2],
				) => {
					const localized = localizeTranscriptContext(model.provider, context);
					const message = await completeSimple(model, localized, options);
					return normalizeAssistantMessage(model.provider, message);
				};
			}
			if (prop === "fetchDeferred" && fetchDeferred) {
				return async (
					model: Parameters<NonNullable<MutableModels["fetchDeferred"]>>[0],
					handle: Parameters<NonNullable<MutableModels["fetchDeferred"]>>[1],
					options?: Parameters<NonNullable<MutableModels["fetchDeferred"]>>[2],
				) => {
					const message = await fetchDeferred(model, handle, options);
					return normalizeAssistantMessage(model.provider, message);
				};
			}
			const value = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

export { asString };
