/**
 * Regenerates the committed contract artifacts:
 *   packages/contract/generated/routes.ts
 *   packages/contract/generated/openapi.json
 *   packages/contract/generated/asyncapi.json
 *
 * OpenAPI and AsyncAPI are internal snapshots (CI freshness, $ref, and
 * validity checks). The Worker does not import or serve them.
 *
 * `bun scripts/generate-contract.ts --check` fails when the committed files differ.
 */
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as contractSchemas from "@cadmus/contract/schemas";

const {
	ApiErrorEnvelopeSchema,
	ClientToServerSchema,
	commandCatalog,
	ERROR_HTTP_STATUS,
	MESSAGE_CHANNELS,
	REST_MAPPING_RULE,
	ServerToClientSchema,
	SseEventSchema,
} = contractSchemas;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "packages/contract/generated");

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type SchemaNode = {
	type?: string;
	description?: string;
	readOnly?: boolean;
	grant?: string;
	properties?: Record<string, SchemaNode>;
	required?: string[];
	const?: string;
	[key: string]: unknown;
};

const check = process.argv.includes("--check");

function cloneSchema(schema: unknown): Json {
	return JSON.parse(JSON.stringify(schema)) as Json;
}

const SCHEMA_REF_PREFIX = "#/components/schemas/";
/** Skip components smaller than a `$ref`; every exported schema is larger. */
const MIN_COMPONENT_CHARS = 60;
const OPENAPI_BYTE_BUDGET = 256 * 1024;

type SchemaLibrary = Map<string, string>;

function componentName(exportName: string): string {
	return exportName.endsWith("Schema")
		? exportName.slice(0, -"Schema".length)
		: exportName;
}

/** Canonical JSON of each exported schema, first name wins for aliases. */
function schemaLibrary(): SchemaLibrary {
	const byJson = new Map<string, string>();
	for (const [key, value] of Object.entries(contractSchemas)) {
		if (!key.endsWith("Schema")) continue;
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			continue;
		}
		const json = JSON.stringify(value);
		if (json.length < MIN_COMPONENT_CHARS) continue;
		if (!byJson.has(json)) byJson.set(json, componentName(key));
	}
	return byJson;
}

function isSchemaNode(node: object): boolean {
	return (
		"type" in node ||
		"anyOf" in node ||
		"oneOf" in node ||
		"allOf" in node ||
		"properties" in node ||
		"$ref" in node ||
		"const" in node ||
		"enum" in node ||
		"items" in node
	);
}

/**
 * Replace a schema node that equals an exported contract schema with `$ref`.
 * `self` skips the root of the component currently being defined.
 */
function rewriteSchema(
	node: Json,
	library: SchemaLibrary,
	self?: string,
	isRoot = false,
): Json {
	if (node === null || typeof node !== "object") return node;
	if (!Array.isArray(node) && isSchemaNode(node)) {
		const name = library.get(JSON.stringify(node));
		if (name && !(isRoot && name === self)) {
			return { $ref: `${SCHEMA_REF_PREFIX}${name}` };
		}
	}
	if (Array.isArray(node)) {
		return node.map((item) => rewriteSchema(item, library));
	}
	const out: { [key: string]: Json } = {};
	for (const [key, value] of Object.entries(node)) {
		out[key] = rewriteSchema(value, library);
	}
	return out;
}

function componentSchemas(library: SchemaLibrary): Record<string, Json> {
	const schemas: Record<string, Json> = {};
	for (const [json, name] of library) {
		schemas[name] = rewriteSchema(
			JSON.parse(json) as Json,
			library,
			name,
			true,
		);
	}
	return schemas;
}

function collectSchemaRefs(node: Json, into: Set<string>): void {
	if (node === null || typeof node !== "object") return;
	if (Array.isArray(node)) {
		for (const item of node) collectSchemaRefs(item, into);
		return;
	}
	for (const [key, value] of Object.entries(node)) {
		if (
			key === "$ref" &&
			typeof value === "string" &&
			value.startsWith(SCHEMA_REF_PREFIX)
		) {
			into.add(value.slice(SCHEMA_REF_PREFIX.length));
			continue;
		}
		collectSchemaRefs(value, into);
	}
}

function pruneSchemas(
	seeds: readonly Json[],
	library: Record<string, Json>,
): Record<string, Json> {
	const needed = new Set<string>();
	const queue: string[] = [];
	const addFrom = (node: Json) => {
		const found = new Set<string>();
		collectSchemaRefs(node, found);
		for (const name of found) {
			if (needed.has(name)) continue;
			needed.add(name);
			queue.push(name);
		}
	};
	for (const seed of seeds) addFrom(seed);
	while (queue.length > 0) {
		const name = queue.pop();
		if (!name) continue;
		const schema = library[name];
		if (!schema) {
			throw new Error(`Missing schema component '${name}'`);
		}
		addFrom(schema);
	}
	const kept: Record<string, Json> = {};
	for (const name of [...needed].sort()) {
		const schema = library[name];
		if (schema) kept[name] = schema;
	}
	return kept;
}

function apiErrorResponse(library: SchemaLibrary): Json {
	const name = library.get(JSON.stringify(ApiErrorEnvelopeSchema));
	if (!name) {
		throw new Error("ApiErrorEnvelopeSchema is not a schema component");
	}
	return {
		description: "Error envelope",
		content: {
			"application/json": {
				schema: { $ref: `${SCHEMA_REF_PREFIX}${name}` },
			},
		},
	};
}

function errorResponseRef(): Json {
	return { $ref: "#/components/responses/ApiError" };
}

function commandPath(command: string): string {
	return `/api/${command.replaceAll(".", "/")}`;
}

/** OpenAPI `x-cadmus-grant`: the grant the command declares in its schema. */
function grantExtension(schema: SchemaNode): Record<string, string> {
	return typeof schema.grant === "string"
		? { "x-cadmus-grant": schema.grant }
		: {};
}

function isReadOnly(schema: SchemaNode): boolean {
	return schema.readOnly === true;
}

const catalogEntries = Object.entries(commandCatalog) as [
	string,
	{ command: SchemaNode; result: SchemaNode },
][];

const routes: Record<
	string,
	{ method: "GET" | "POST"; path: string; allow: string; readOnly: boolean }
> = {};

for (const [name, entry] of catalogEntries) {
	const readOnly = isReadOnly(entry.command);
	routes[name] = {
		method: readOnly ? "GET" : "POST",
		path: commandPath(name),
		allow: readOnly ? "GET, HEAD" : "POST",
		readOnly,
	};
}

function renderRoutes(): string {
	const body = JSON.stringify(routes, null, "\t")
		.split("\n")
		.map((line, index) => (index === 0 ? line : `\t${line}`))
		.join("\n");
	return `// Generated by scripts/generate-contract.ts. Do not edit.
// Method and path come from each command schema's readOnly flag and the
// REST mapping rule (readOnly => GET/HEAD, otherwise POST; /api/<group>/<cmd>).

export type ApiRoute = {
	method: "GET" | "POST";
	path: string;
	allow: string;
	readOnly: boolean;
};

export const API_ROUTES = ${body} as const satisfies Record<string, ApiRoute>;

export type ApiCommandName = keyof typeof API_ROUTES;

/** Google redirects the browser here. This is not a client command. */
export const AUTH_LOGIN_GOOGLE_CALLBACK_PATH =
	"/api/auth/login/google/callback";

export function routeForCommand<C extends ApiCommandName>(
	command: C,
): (typeof API_ROUTES)[C] {
	return API_ROUTES[command];
}

/**
 * Query encoding for readOnly GET/HEAD payloads.
 * Implements REST_MAPPING_RULE.queryEncoding. This is the only encoder.
 * The Worker re-exports it from @cadmus/contract/routes. The server decoder
 * is coerceSearchParamsToPayload in src/protocol/rest.ts.
 */
export function encodePayloadQuery(
	payload: Record<string, unknown>,
): URLSearchParams {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(payload)) {
		if (value === undefined) continue;
		appendQueryValue(params, key, value);
	}
	return params;
}

function appendQueryValue(
	params: URLSearchParams,
	key: string,
	value: unknown,
): void {
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		params.append(key, String(value));
		return;
	}
	if (Array.isArray(value)) {
		const nested = value.some(
			(item) => item !== null && typeof item === "object",
		);
		if (nested) {
			params.append(key, JSON.stringify(value));
			return;
		}
		for (const item of value) {
			if (
				typeof item === "string" ||
				typeof item === "number" ||
				typeof item === "boolean"
			) {
				params.append(key, String(item));
			} else if (item !== undefined) {
				params.append(key, JSON.stringify(item));
			}
		}
		return;
	}
	params.append(key, JSON.stringify(value));
}
`;
}

function payloadSchema(command: SchemaNode): SchemaNode | undefined {
	const payload = command.properties?.payload;
	if (payload?.type !== "object") return undefined;
	return payload;
}

function operation(
	name: string,
	entry: { command: SchemaNode; result: SchemaNode },
	library: SchemaLibrary,
) {
	const readOnly = isReadOnly(entry.command);
	const payload = payloadSchema(entry.command);
	const success = {
		description: "Command result",
		content: {
			"application/json": {
				schema: rewriteSchema(cloneSchema(entry.result), library),
			},
		},
	};
	const error = errorResponseRef();
	const responses = {
		"200": success,
		"400": error,
		"401": error,
		"404": error,
		"405": error,
		"409": error,
		"500": error,
	};
	const summary =
		typeof entry.command.description === "string"
			? entry.command.description
			: name;
	if (readOnly) {
		const parameters = Object.entries(payload?.properties ?? {}).map(
			([prop, schema]) => ({
				name: prop,
				in: "query",
				required: payload?.required?.includes(prop) ?? false,
				schema: rewriteSchema(cloneSchema(schema), library),
				...(typeof schema.description === "string"
					? { description: schema.description }
					: {}),
			}),
		);
		return {
			get: {
				operationId: name,
				...grantExtension(entry.command),
				summary,
				parameters,
				responses,
			},
			head: {
				operationId: `${name}.head`,
				...grantExtension(entry.command),
				summary,
				parameters,
				responses: {
					"200": { description: "Same as GET with an empty body" },
					"400": error,
					"401": error,
					"404": error,
					"405": error,
				},
			},
		};
	}
	return {
		post: {
			operationId: name,
			...grantExtension(entry.command),
			summary,
			requestBody: {
				required: true,
				content: {
					"application/json": {
						schema: rewriteSchema(
							cloneSchema(payload ?? { type: "object" }),
							library,
						),
					},
				},
			},
			responses,
		},
	};
}

function renderOpenApi(): string {
	const library = schemaLibrary();
	const allComponents = componentSchemas(library);
	const paths: Record<string, Json> = {};
	for (const [name, entry] of catalogEntries) {
		paths[commandPath(name)] = operation(
			name,
			entry,
			library,
		) as unknown as Json;
	}
	const responses: Record<string, Json> = {
		ApiError: apiErrorResponse(library),
	};
	const document = {
		openapi: "3.1.0",
		info: {
			title: "Cadmus HTTP API",
			version: "1.0.0",
			description:
				"REST translation of the Cadmus command protocol. Generated from @cadmus/contract. readOnly commands are GET and HEAD with query parameters; other commands are POST JSON. Authorization is a Bearer header. A token query parameter is rejected.",
		},
		servers: [{ url: "/" }],
		security: [{ bearerAuth: [] }],
		paths,
		components: {
			securitySchemes: {
				bearerAuth: { type: "http", scheme: "bearer" },
			},
			responses,
			schemas: pruneSchemas([paths, responses], allComponents),
		},
		"x-cadmus-rest-rule": REST_MAPPING_RULE,
		"x-cadmus-error-status": ERROR_HTTP_STATUS,
	};
	// Compact input: Biome keeps an object expanded when the source breaks after
	// its `{`, so pretty input would stay fully expanded and fill the byte budget.
	// Biome still owns the final layout.
	return `${JSON.stringify(document)}\n`;
}

function renderAsyncApi(): string {
	const library = schemaLibrary();
	const allComponents = componentSchemas(library);
	const document = {
		asyncapi: "3.0.0",
		info: {
			title: "Cadmus WebSocket and SSE",
			version: "1.0.0",
			description:
				"Generated from @cadmus/contract. /ws carries ClientToServer commands and ServerToClient frames (command.result and events). /events is Server-Sent Events whose data field is a ServerEvent. command.result is not sent on /events. A `: connected` comment is a heartbeat.",
		},
		defaultContentType: "application/json",
		servers: {
			cadmus: {
				host: "localhost",
				protocol: "ws",
				pathname: MESSAGE_CHANNELS.ws.address,
			},
		},
		channels: {
			ws: {
				address: MESSAGE_CHANNELS.ws.address,
				messages: {
					clientToServer: {
						$ref: "#/components/messages/ClientToServer",
					},
					serverToClient: {
						$ref: "#/components/messages/ServerToClient",
					},
				},
			},
			events: {
				address: MESSAGE_CHANNELS.events.address,
				description:
					"SSE. Each data field is a JSON ServerEvent. Auth matches /ws (query token and session cookie are accepted). This is not /api.",
				messages: {
					sseEvent: { $ref: "#/components/messages/SseEvent" },
				},
			},
		},
		operations: {
			sendCommand: {
				action: "send",
				channel: { $ref: "#/channels/ws" },
				messages: [{ $ref: "#/channels/ws/messages/clientToServer" }],
			},
			receiveWs: {
				action: "receive",
				channel: { $ref: "#/channels/ws" },
				messages: [{ $ref: "#/channels/ws/messages/serverToClient" }],
			},
			receiveSse: {
				action: "receive",
				channel: { $ref: "#/channels/events" },
				messages: [{ $ref: "#/channels/events/messages/sseEvent" }],
			},
		},
		components: {
			messages: {
				ClientToServer: {
					name: "ClientToServer",
					title: "Client command",
					contentType: "application/json",
					payload: rewriteSchema(cloneSchema(ClientToServerSchema), library),
				},
				ServerToClient: {
					name: "ServerToClient",
					title: "Server frame",
					contentType: "application/json",
					payload: rewriteSchema(cloneSchema(ServerToClientSchema), library),
				},
				SseEvent: {
					name: "SseEvent",
					title: "SSE event",
					contentType: "application/json",
					payload: rewriteSchema(cloneSchema(SseEventSchema), library),
				},
			},
			schemas: {} as Record<string, Json>,
		},
	};
	document.components.schemas = pruneSchemas(
		[document.components.messages],
		allComponents,
	);
	return `${JSON.stringify(document, null, "\t")}\n`;
}

function formatWithBiome(filename: string, contents: string): string {
	// Biome's default file size cap is 1 MiB. Larger documents keep the
	// generator's JSON.stringify bytes.
	if (contents.length > 1_000_000) return contents;
	const scratch = mkdtempSync(join(tmpdir(), "cadmus-contract-"));
	try {
		const file = join(scratch, filename);
		writeFileSync(file, contents);
		// `--vcs-enabled=false` keeps Biome from requiring the scratch file to
		// live under the git root. The project config still comes from `cwd`.
		const result = spawnSync(
			"bunx",
			["biome", "format", "--write", "--vcs-enabled=false", file],
			{
				cwd: root,
				encoding: "utf8",
			},
		);
		if (result.status !== 0) {
			process.stderr.write(
				result.stderr || result.stdout || "biome format failed\n",
			);
			process.exit(result.status ?? 1);
		}
		return readFileSync(file, "utf8");
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

function assertOpenApiBudget(contents: string): void {
	const bytes = Buffer.byteLength(contents);
	if (bytes >= OPENAPI_BYTE_BUDGET) {
		process.stderr.write(
			`openapi.json is ${bytes} bytes; expected under 256 KiB.\n`,
		);
		process.exit(1);
	}
}

const openApiText = formatWithBiome("openapi.json", renderOpenApi());
assertOpenApiBudget(openApiText);

const files: Record<string, string> = {
	[resolve(outDir, "routes.ts")]: formatWithBiome("routes.ts", renderRoutes()),
	[resolve(outDir, "openapi.json")]: openApiText,
	[resolve(outDir, "asyncapi.json")]: formatWithBiome(
		"asyncapi.json",
		renderAsyncApi(),
	),
};

if (check) {
	const stale: string[] = [];
	for (const [path, next] of Object.entries(files)) {
		let current = "";
		try {
			current = readFileSync(path, "utf8");
		} catch {
			current = "";
		}
		if (current !== next) stale.push(path);
	}
	if (stale.length > 0) {
		process.stderr.write(
			`Contract artifacts are stale. Run \`bun scripts/generate-contract.ts\`.\n${stale.join("\n")}\n`,
		);
		process.exit(1);
	}
	process.stdout.write("Contract artifacts are fresh.\n");
} else {
	mkdirSync(outDir, { recursive: true });
	for (const [path, next] of Object.entries(files)) {
		writeFileSync(path, next);
	}
	process.stdout.write(
		`Wrote ${Object.keys(files).length} contract artifacts.\n`,
	);
}
