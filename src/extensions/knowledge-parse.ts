const SLUG: Record<"bot" | "knowledge", RegExp> = {
	/** `bots/<botId>`, 1–32 characters. */
	bot: /^[a-z0-9][a-z0-9-]{0,31}$/,
	/** `knowledge/<slug>.md`, 1–64 characters. */
	knowledge: /^[a-z0-9][a-z0-9-]{0,63}$/,
};

/** The slug when `value` matches `kind`, otherwise `undefined`. */
export function parseSlug(
	value: string,
	kind: "bot" | "knowledge",
): string | undefined {
	return SLUG[kind].test(value) ? value : undefined;
}

function parseOneLine(value: string, max: number): string | undefined {
	if (/[\r\n]/.test(value)) return undefined;
	const text = value.trim();
	if (!text || text.length > max) return undefined;
	return text;
}

export type KnowledgeLineSpec = {
	label: string;
	description: string;
	max: number;
	required: boolean;
	/** When omitted on write, keep the current file value. */
	omitKeeps?: boolean;
};

/**
 * Known frontmatter line fields. Add a field here and parse, format, the
 * knowledge tools, the HTTP file API, and the editor all pick it up.
 */
export const KNOWLEDGE_LINE_FIELDS = {
	description: {
		label: "Description",
		description:
			"One-line description for the knowledge index, 1–240 characters.",
		max: 240,
		required: true,
	},
	category: {
		label: "Category",
		description:
			"Optional grouping label, one line, at most 64 characters. Omit to keep the current value; empty string clears it.",
		max: 64,
		required: false,
		omitKeeps: true,
	},
} as const satisfies Record<string, KnowledgeLineSpec>;

export const KNOWLEDGE_VERSION_FIELD = {
	name: "version" as const,
	label: "Version",
	description:
		"Version returned by knowledge_read. 0 when the file does not exist.",
};

export const KNOWLEDGE_BODY_FIELD = {
	name: "body" as const,
	label: "Body",
	description:
		"Markdown body without frontmatter. Empty is allowed. Must not start with ---.",
};

export type KnowledgeLineName = keyof typeof KNOWLEDGE_LINE_FIELDS;

export type KnowledgeLineField = {
	kind: "line";
	name: KnowledgeLineName;
} & KnowledgeLineSpec;

export type KnowledgeVersionField = {
	kind: "version";
	name: "version";
	label: string;
	description: string;
};

export type KnowledgeBodyField = {
	kind: "body";
	name: "body";
	label: string;
	description: string;
};

export type KnowledgeField =
	| KnowledgeLineField
	| KnowledgeVersionField
	| KnowledgeBodyField;

function lineSpecs(): KnowledgeLineField[] {
	return (Object.keys(KNOWLEDGE_LINE_FIELDS) as KnowledgeLineName[]).map(
		(name) => ({
			kind: "line",
			name,
			...KNOWLEDGE_LINE_FIELDS[name],
		}),
	);
}

/** Editor and tool order: line fields, version (readonly in the UI), body. */
export const KNOWLEDGE_FIELDS: readonly KnowledgeField[] = [
	...lineSpecs(),
	{ kind: "version", ...KNOWLEDGE_VERSION_FIELD },
	{ kind: "body", ...KNOWLEDGE_BODY_FIELD },
];

type LineFields = typeof KNOWLEDGE_LINE_FIELDS;
type RequiredLines = {
	[K in keyof LineFields as LineFields[K]["required"] extends true
		? K
		: never]: string;
};
type OptionalLines = {
	[K in keyof LineFields as LineFields[K]["required"] extends true
		? never
		: K]?: string;
};

export type KnowledgeDoc = RequiredLines &
	OptionalLines & {
		version: number;
		body: string;
	};

/**
 * A knowledge `description` field: 1–240 characters, no newlines.
 * Used on tool arguments and on the frontmatter value.
 */
export function parseDescriptionField(value: string): string | undefined {
	return parseOneLine(value, KNOWLEDGE_LINE_FIELDS.description.max);
}

/**
 * Optional grouping label: 1–64 characters, no newlines.
 */
export function parseCategoryField(value: string): string | undefined {
	return parseOneLine(value, KNOWLEDGE_LINE_FIELDS.category.max);
}

/**
 * Body of a knowledge file. Rejects a body that starts with a YAML `---` fence,
 * which is how the model accidentally pastes a whole document into `body`.
 */
export function parseKnowledgeBody(body: string): string | undefined {
	const trimmed = body.replace(/^\uFEFF/, "").replace(/^\s+/, "");
	if (trimmed.startsWith("---")) return undefined;
	return body;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function parseVersionField(value: string): number | undefined {
	const raw = value.trim();
	if (!/^(0|[1-9][0-9]*)$/.test(raw)) return undefined;
	const version = Number(raw);
	if (!Number.isSafeInteger(version)) return undefined;
	return version;
}

/** Whole-number version from a tool argument or HTTP body. */
export function parseVersion(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
		return undefined;
	if (!Number.isSafeInteger(value)) return undefined;
	return value;
}

export function lineFieldError(spec: {
	name: string;
	max: number;
	required: boolean;
}): string {
	return spec.required
		? `${spec.name} is required, one line, at most ${spec.max} characters.`
		: `${spec.name} is one line, at most ${spec.max} characters.`;
}

/**
 * A knowledge file: known line fields, `version` optional (defaults to 0).
 * Any other frontmatter key is unreadable.
 */
export function parseKnowledge(text: string): KnowledgeDoc | undefined {
	const match = FRONTMATTER.exec(text);
	if (!match) return undefined;
	const raw = match[1] ?? "";
	if (raw === "") return undefined;
	const lines: Record<string, string> = {};
	let version: number | undefined;
	for (const line of raw.split(/\r?\n/)) {
		const kv = /^([a-z]+):[ \t]*(.*)$/.exec(line);
		if (!kv) return undefined;
		const key = kv[1] ?? "";
		const value = kv[2] ?? "";
		if (key === "version") {
			if (version !== undefined) return undefined;
			version = parseVersionField(value);
			if (version === undefined) return undefined;
			continue;
		}
		if (key in lines) return undefined;
		const spec = (KNOWLEDGE_LINE_FIELDS as Record<string, KnowledgeLineSpec>)[
			key
		];
		if (!spec) return undefined;
		const parsed = parseOneLine(value, spec.max);
		if (!parsed) return undefined;
		lines[key] = parsed;
	}
	for (const field of lineSpecs()) {
		if (field.required && !lines[field.name]) return undefined;
	}
	const body = parseKnowledgeBody(text.slice(match[0].length));
	if (body === undefined) return undefined;
	return knowledgeDocFromLines(lines, version ?? 0, body);
}

function knowledgeDocFromLines(
	lines: Record<string, string>,
	version: number,
	body: string,
): KnowledgeDoc {
	return { ...lines, version, body } as KnowledgeDoc;
}

/**
 * The `description` of a knowledge file: a readable frontmatter block.
 * Any other shape is unreadable.
 */
export function parseDescription(text: string): string | undefined {
	return parseKnowledge(text)?.description;
}

/** Why `text` is not a readable knowledge file. */
export function knowledgeParseError(text: string): string {
	const match = FRONTMATTER.exec(text);
	if (match) {
		const body = text.slice(match[0].length);
		if (parseKnowledgeBody(body) === undefined)
			return "body must not start with frontmatter (---).";
		for (const line of (match[1] ?? "").split(/\r?\n/)) {
			const kv = /^([a-z]+):[ \t]*(.*)$/.exec(line);
			if (!kv) continue;
			const key = kv[1] ?? "";
			const spec = (KNOWLEDGE_LINE_FIELDS as Record<string, KnowledgeLineSpec>)[
				key
			];
			if (spec && !spec.required && !parseOneLine(kv[2] ?? "", spec.max))
				return lineFieldError({ name: key, max: spec.max, required: false });
		}
	}
	const required = lineSpecs().find((field) => field.required);
	if (required) return lineFieldError(required);
	return "The knowledge file is unreadable.";
}

/** Canonical knowledge document. Always writes `version`. Omits empty optional keys. */
export function formatKnowledge(doc: KnowledgeDoc): string {
	const parts = ["---"];
	for (const field of lineSpecs()) {
		const value = doc[field.name];
		if (typeof value !== "string" || value === "") continue;
		parts.push(`${field.name}: ${value}`);
	}
	parts.push(`version: ${doc.version}`);
	parts.push("---");
	return `${parts.join("\n")}\n${doc.body}`;
}

/** Prompt index line: path, optional category, description. */
export function knowledgeIndexLine(name: string, doc: KnowledgeDoc): string {
	return doc.category
		? `knowledge/${name} — ${doc.category} — ${doc.description}`
		: `knowledge/${name} — ${doc.description}`;
}

export type LinePatch = { keep: true } | { keep: false; value?: string };

export type KnowledgeWrite = {
	version: number;
	body: string;
	lines: Record<string, LinePatch>;
};

export type KnowledgeRecord = {
	slug: string;
	version: number;
	body: string;
	description: string;
	category?: string;
	exists?: boolean;
	created?: boolean;
};

/**
 * Structured write from a tool call or the HTTP API. Frontmatter stays on disk.
 */
export function parseKnowledgeWrite(
	args: Record<string, unknown>,
): { ok: true; value: KnowledgeWrite } | { ok: false; error: string } {
	const version = parseVersion(args.version);
	if (version === undefined)
		return { ok: false, error: "Version is not a whole number." };
	if (typeof args.body !== "string")
		return { ok: false, error: KNOWLEDGE_BODY_FIELD.description };
	if (parseKnowledgeBody(args.body) === undefined)
		return { ok: false, error: "body must not start with frontmatter (---)." };
	const lines: Record<string, LinePatch> = {};
	for (const field of lineSpecs()) {
		const raw = args[field.name];
		if (raw === undefined) {
			if (field.required) return { ok: false, error: lineFieldError(field) };
			lines[field.name] = field.omitKeeps ? { keep: true } : { keep: false };
			continue;
		}
		if (typeof raw !== "string")
			return { ok: false, error: lineFieldError(field) };
		if (raw.trim() === "") {
			if (field.required) return { ok: false, error: lineFieldError(field) };
			lines[field.name] = { keep: false };
			continue;
		}
		const parsed = parseOneLine(raw, field.max);
		if (!parsed) return { ok: false, error: lineFieldError(field) };
		lines[field.name] = { keep: false, value: parsed };
	}
	return { ok: true, value: { version, body: args.body, lines } };
}

export function applyKnowledgeWrite(
	existing: KnowledgeDoc | undefined,
	write: KnowledgeWrite,
): KnowledgeDoc {
	const lines: Record<string, string> = {};
	for (const field of lineSpecs()) {
		const patch = write.lines[field.name];
		if (!patch || patch.keep) {
			const prev = existing?.[field.name];
			if (typeof prev === "string") lines[field.name] = prev;
			continue;
		}
		if (patch.value !== undefined) lines[field.name] = patch.value;
	}
	return knowledgeDocFromLines(lines, write.version + 1, write.body);
}

export function knowledgePublicFields(
	doc: KnowledgeDoc,
): Record<string, string | number> {
	const out: Record<string, string | number> = {
		version: doc.version,
		body: doc.body,
	};
	for (const field of lineSpecs()) {
		const value = doc[field.name];
		if (typeof value === "string" && value !== "") out[field.name] = value;
	}
	return out;
}

export function knowledgeReadRecord(
	slug: string,
	doc: KnowledgeDoc,
): KnowledgeRecord {
	return {
		slug,
		exists: true,
		...knowledgePublicFields(doc),
	} as KnowledgeRecord;
}

export function knowledgeWriteRecord(
	slug: string,
	doc: KnowledgeDoc,
	created: boolean,
): KnowledgeRecord {
	return {
		slug,
		created,
		...knowledgePublicFields(doc),
	} as KnowledgeRecord;
}

export type KnowledgeDraft = {
	slug: string;
	version: number;
	body: string;
	lines: Record<string, string>;
};

export function emptyKnowledgeDraft(slug: string): KnowledgeDraft {
	const lines: Record<string, string> = {};
	for (const field of lineSpecs()) lines[field.name] = "";
	return { slug, version: 0, body: "", lines };
}

export function draftFromRecord(record: KnowledgeRecord): KnowledgeDraft {
	const lines: Record<string, string> = {};
	for (const field of lineSpecs()) {
		const value = record[field.name as keyof KnowledgeRecord];
		lines[field.name] = typeof value === "string" ? value : "";
	}
	return {
		slug: record.slug,
		version: record.version,
		body: record.body,
		lines,
	};
}

export function knowledgeWriteArgs(
	draft: KnowledgeDraft,
): Record<string, unknown> {
	return {
		version: draft.version,
		body: draft.body,
		...draft.lines,
	};
}
