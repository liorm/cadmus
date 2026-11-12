import {
	ClientCommandSchema,
	type CommandType,
	DEFAULT_ERROR_HTTP_STATUS,
	ERROR_HTTP_STATUS,
	NOT_FOUND_CODE_SUFFIX,
	REST_RESERVED_QUERY_KEYS,
} from "@cadmus/contract/schemas";
import { Value } from "typebox/value";
import { apiPathFromCommandType } from "./rest-encode.js";
import { ProtocolValidationError } from "./validate.js";

export {
	apiPathFromCommandType,
	commandTypeFromApiPath,
} from "./rest-encode.js";

/**
 * Structural view of a TypeBox JSON schema node. `TSchema` itself is an empty
 * marker interface, so the fields we read are declared here.
 */
type SchemaNode = {
	type?: string;
	readOnly?: boolean;
	grant?: string;
	properties?: Record<string, SchemaNode>;
	items?: SchemaNode;
	anyOf?: SchemaNode[];
};

/**
 * REST translation for the Cadmus protocol (`/api/*`).
 *
 * Command names and URL paths are the same identifier with dots and slashes swapped:
 * `file.read` <-> `/api/file/read`, `account.members.list` <-> `/api/account/members/list`.
 *
 * Whether a command is safe to expose as `GET` is **not** a separate table. It is the
 * TypeBox `readOnly` schema option on that command (`SchemaOptions.readOnly`).
 * `isCommandReadOnly` reads it back from `ClientCommandSchema`. Mutating commands omit
 * the flag and map to `POST`.
 *
 * Path strings live in `rest-encode.ts` (no TypeBox) and are re-exported here.
 * `encodePayloadQuery` is the generated encoder in `@cadmus/contract/routes`,
 * re-exported from `src/protocol.ts`. `coerceSearchParamsToPayload` decodes
 * that query string.
 */

/**
 * Query keys consumed by edge family routing.
 * They are not command payload fields unless the payload schema lists them
 * (`familyId` on family commands). When they are not payload fields they are
 * ignored here; `authenticateRequest` has already applied them to the scope.
 *
 * `token` is not reserved. `/api` rejects a `token` query parameter before
 * coercion, and a leftover `token` key is an unknown parameter.
 */
const RESERVED_QUERY_KEYS = new Set<string>(REST_RESERVED_QUERY_KEYS);

type CommandVariant = SchemaNode & {
	properties?: {
		type?: { const?: string };
		payload?: SchemaNode;
	};
};

function commandVariants(): readonly CommandVariant[] {
	const union = ClientCommandSchema as SchemaNode & {
		anyOf?: CommandVariant[];
	};
	return union.anyOf ?? [];
}

function commandTypeOf(variant: CommandVariant): string | undefined {
	const type = variant.properties?.type?.const;
	return typeof type === "string" ? type : undefined;
}

/**
 * The TypeBox object schema for one command, including its `readOnly` option.
 * Returns undefined when `commandType` is not in `ClientCommandSchema`.
 */
export function getCommandSchema(
	commandType: string,
): CommandVariant | undefined {
	for (const variant of commandVariants()) {
		if (commandTypeOf(variant) === commandType) return variant;
	}
	return undefined;
}

/** The grant a command schema declares (`grant` option), if any. */
export function getCommandGrant(commandType: string): string | undefined {
	const grant = getCommandSchema(commandType)?.grant;
	return typeof grant === "string" ? grant : undefined;
}

/** Every command type declared on `ClientCommandSchema`, in schema order. */
export function listCommandTypes(): CommandType[] {
	const types: CommandType[] = [];
	for (const variant of commandVariants()) {
		const type = commandTypeOf(variant);
		if (type) types.push(type as CommandType);
	}
	return types;
}

/**
 * True when the command schema sets `readOnly: true`.
 * Unknown names are not readonly (callers should 404 them before using this).
 */
export function isCommandReadOnly(commandType: CommandType): boolean {
	return getCommandSchema(commandType)?.readOnly === true;
}

/** Command types whose schema sets `readOnly: true`, in schema order. */
export function listReadOnlyCommandTypes(): CommandType[] {
	return listCommandTypes().filter((type) => isCommandReadOnly(type));
}

/** `Allow` header value. Readonly commands accept `GET` and `HEAD`. */
export function allowHeaderForCommand(commandType: CommandType): string {
	return isCommandReadOnly(commandType) ? "GET, HEAD" : "POST";
}

/**
 * Method and path a JSON client should use for this command.
 * Readonly commands are `GET` (payload as query string). Others are `POST`
 * (payload as the JSON body).
 */
export function apiRouteForCommand(commandType: CommandType): {
	method: "GET" | "POST";
	path: string;
	allow: string;
} {
	return {
		method: isCommandReadOnly(commandType) ? "GET" : "POST",
		path: apiPathFromCommandType(commandType),
		allow: allowHeaderForCommand(commandType),
	};
}

/**
 * HTTP status for a protocol error `code` on `/api/*`.
 *
 * | code | status |
 * | --- | --- |
 * | `unauthorized` | 401 |
 * | `forbidden` | 403 |
 * | `not_found`, `family_not_found`, or any `*_not_found` | 404 |
 * | `cas_conflict`, `conflict` | 409 |
 * | `command_failed` | 500 |
 * | `invalid_command`, `invalid_json`, `invalid_frame`, `frame_too_large`, anything else | 400 |
 *
 * `/rpc` is unchanged: the Durable Object still returns 400 for failed command
 * results. Only the REST adapter remaps these codes.
 */
export function httpStatusForProtocolCode(code: string): number {
	if (Object.hasOwn(ERROR_HTTP_STATUS, code)) {
		return ERROR_HTTP_STATUS[code as keyof typeof ERROR_HTTP_STATUS];
	}
	return code.endsWith(NOT_FOUND_CODE_SUFFIX) ? 404 : DEFAULT_ERROR_HTTP_STATUS;
}

function payloadSchemaOf(commandType: string): SchemaNode {
	const payload = getCommandSchema(commandType)?.properties?.payload;
	if (payload?.type !== "object") {
		throw new ProtocolValidationError(
			`Command '${commandType}' has no object payload schema`,
			"invalid_command",
		);
	}
	return payload;
}

/**
 * Coerce a `GET` query string into a command payload using the command's
 * TypeBox payload schema.
 *
 * - `boolean`: `true` or `false` (any case)
 * - `integer`: base-10 integer text (`-?\d+`)
 * - `number`: JSON number text
 * - `string`: the raw query value
 * - arrays: one value per repeated key, or a single JSON array
 * - objects (and other nested values): one JSON-encoded query value
 * - unions: the first successful coercion among boolean, number, JSON, then string
 *
 * `accountId`, `userId`, and `familyId` are skipped when they are not payload
 * properties. `token` is not skipped. Any other unknown key is rejected.
 */
export function coerceSearchParamsToPayload(
	commandType: CommandType,
	params: URLSearchParams,
): Record<string, unknown> {
	const payloadSchema = payloadSchemaOf(commandType);
	return coerceQueryToSchema(payloadSchema, params);
}

/** Same coercion as `coerceSearchParamsToPayload`, against an explicit object schema. */
export function coerceQueryToSchema(
	payloadSchema: SchemaNode,
	params: URLSearchParams,
): Record<string, unknown> {
	if (payloadSchema.type !== "object") {
		throw new ProtocolValidationError(
			"Query payload schema must be an object",
			"invalid_command",
		);
	}
	const properties = payloadSchema.properties ?? {};
	const grouped = new Map<string, string[]>();
	for (const [key, value] of params) {
		const list = grouped.get(key);
		if (list) list.push(value);
		else grouped.set(key, [value]);
	}

	for (const key of grouped.keys()) {
		if (key in properties) continue;
		if (RESERVED_QUERY_KEYS.has(key)) continue;
		throw new ProtocolValidationError(
			`Unknown query parameter '${key}'`,
			"invalid_command",
		);
	}

	const result: Record<string, unknown> = {};
	for (const [key, schema] of Object.entries(properties)) {
		const values = grouped.get(key);
		if (!values) continue;
		result[key] = coerceProperty(schema, values, key);
	}
	return result;
}

function coerceProperty(
	schema: SchemaNode,
	values: string[],
	key: string,
): unknown {
	if (schema.type === "array") {
		return coerceArray(schema, values, key);
	}
	if (values.length !== 1) {
		throw new ProtocolValidationError(
			`Query parameter '${key}' must not be repeated`,
			"invalid_command",
		);
	}
	return coerceScalar(schema, values[0] ?? "", key);
}

function coerceArray(
	schema: SchemaNode,
	values: string[],
	key: string,
): unknown {
	const only = values.length === 1 ? values[0] : undefined;
	if (only?.trimStart().startsWith("[")) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(only);
		} catch {
			throw new ProtocolValidationError(
				`Query parameter '${key}' must be a JSON array or repeated keys`,
				"invalid_command",
			);
		}
		if (Value.Check(schema as Parameters<typeof Value.Check>[0], parsed)) {
			return parsed;
		}
		throw new ProtocolValidationError(
			`Query parameter '${key}' does not match the expected array schema`,
			"invalid_command",
		);
	}
	const itemSchema = schema.items;
	if (!itemSchema) {
		throw new ProtocolValidationError(
			`Query parameter '${key}' is missing an array item schema`,
			"invalid_command",
		);
	}
	return values.map((value) => coerceScalar(itemSchema, value, key));
}

function coerceScalar(schema: SchemaNode, raw: string, key: string): unknown {
	for (const candidate of scalarCandidates(raw)) {
		if (Value.Check(schema as Parameters<typeof Value.Check>[0], candidate)) {
			return candidate;
		}
	}
	if (
		schema.type === "object" ||
		raw.trimStart().startsWith("{") ||
		raw.trimStart().startsWith("[")
	) {
		throw new ProtocolValidationError(
			`Query parameter '${key}' must be a JSON-encoded ${schema.type === "object" ? "object" : "value"}`,
			"invalid_command",
		);
	}
	const expected = schema.type ?? "value";
	throw new ProtocolValidationError(
		`Query parameter '${key}' is not a valid ${expected}`,
		"invalid_command",
	);
}

/**
 * Candidate values for one query string, most specific first.
 * Query strings are always text; a numeric or boolean schema match wins over
 * the raw string so `?includeInternal=false` does not stay a string.
 */
function scalarCandidates(raw: string): unknown[] {
	const candidates: unknown[] = [];
	if (/^(true|false)$/i.test(raw)) {
		candidates.push(raw.toLowerCase() === "true");
	}
	if (/^-?\d+$/.test(raw)) {
		candidates.push(Number(raw));
	} else if (/^-?(?:\d+\.\d+|\d+)(?:[eE][+-]?\d+)?$/.test(raw)) {
		const numeric = Number(raw);
		if (Number.isFinite(numeric)) candidates.push(numeric);
	}
	const trimmed = raw.trimStart();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			candidates.push(JSON.parse(raw));
		} catch {
			// Leave a schema-specific error to the caller when nothing matches.
		}
	}
	candidates.push(raw);
	return candidates;
}
