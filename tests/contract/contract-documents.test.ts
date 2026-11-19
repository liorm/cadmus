import { describe, expect, it } from "bun:test";
import SwaggerParser from "@apidevtools/swagger-parser";
import asyncApiDocument from "@cadmus/contract/asyncapi.json";
import openApiDocument from "@cadmus/contract/openapi.json";
import {
	ApiErrorEnvelopeSchema,
	ClientToServerSchema,
	commandCatalog,
	ServerToClientSchema,
	SseEventSchema,
} from "@cadmus/contract/schemas";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function clone(value: unknown): Json {
	return JSON.parse(JSON.stringify(value)) as Json;
}

function pointer(root: unknown, ref: string): unknown {
	if (!ref.startsWith("#/")) return undefined;
	const segments = ref
		.slice(2)
		.split("/")
		.map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
	let current: unknown = root;
	for (const segment of segments) {
		if (current === null || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[segment];
		if (current === undefined) return undefined;
	}
	return current;
}

function refsOf(node: unknown, into: string[]): void {
	if (node === null || typeof node !== "object") return;
	if (Array.isArray(node)) {
		for (const item of node) refsOf(item, into);
		return;
	}
	for (const [key, value] of Object.entries(node)) {
		if (key === "$ref") {
			if (typeof value === "string") into.push(value);
			continue;
		}
		refsOf(value, into);
	}
}

function assertRefsResolve(document: unknown): void {
	const refs: string[] = [];
	refsOf(document, refs);
	expect(refs.length).toBeGreaterThan(0);
	const missing = refs.filter(
		(ref) => !ref.startsWith("#/") || pointer(document, ref) === undefined,
	);
	expect(missing).toEqual([]);
}

function deref(
	node: unknown,
	root: unknown,
	seen = new Set<string>(),
): unknown {
	if (node === null || typeof node !== "object") return node;
	if (Array.isArray(node)) return node.map((item) => deref(item, root, seen));
	const record = node as Record<string, unknown>;
	const ref = record.$ref;
	if (typeof ref === "string") {
		if (Object.keys(record).length !== 1) {
			throw new Error(`$ref has siblings: ${ref}`);
		}
		if (seen.has(ref)) throw new Error(`cyclic $ref ${ref}`);
		const target = pointer(root, ref);
		if (target === undefined) throw new Error(`unresolved $ref ${ref}`);
		seen.add(ref);
		const resolved = deref(target, root, seen);
		seen.delete(ref);
		return resolved;
	}
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		out[key] = deref(value, root, seen);
	}
	return out;
}

describe("generated API documents", () => {
	it("resolves every OpenAPI $ref", async () => {
		const document = openApiDocument as {
			openapi: string;
			components: {
				schemas: Record<string, unknown>;
				responses: Record<string, unknown>;
			};
		};
		expect(document.openapi).toBe("3.1.0");
		expect(document.components.schemas.ApiErrorEnvelope).toBeTruthy();
		expect(document.components.responses.ApiError).toBeTruthy();
		assertRefsResolve(document);
		expect(JSON.stringify(document).split('"$ref"').length - 1).toBeGreaterThan(
			10,
		);
		const validated = await SwaggerParser.validate(structuredClone(document));
		expect(validated.openapi).toBe("3.1.0");
	});

	it("keeps AsyncAPI 3 components and resolves every $ref", () => {
		const document = asyncApiDocument as { asyncapi: string };
		expect(document.asyncapi).toBe("3.0.0");
		assertRefsResolve(document);
	});

	it("dereferences to the contract schemas", () => {
		const openapi = openApiDocument as {
			paths: Record<
				string,
				{
					get?: {
						parameters?: {
							name: string;
							in: string;
							required: boolean;
							schema: unknown;
						}[];
						responses: Record<string, unknown>;
					};
					post?: {
						requestBody: {
							content: { "application/json": { schema: unknown } };
						};
						responses: Record<string, unknown>;
					};
				}
			>;
			components: {
				responses: {
					ApiError: {
						content: { "application/json": { schema: unknown } };
					};
				};
			};
		};
		expect(
			deref(
				openapi.components.responses.ApiError.content["application/json"]
					.schema,
				openapi,
			),
		).toEqual(clone(ApiErrorEnvelopeSchema));

		for (const [name, entry] of Object.entries(commandCatalog)) {
			const path = `/api/${name.replaceAll(".", "/")}`;
			const operation = openapi.paths[path];
			expect(operation, name).toBeTruthy();
			if (!operation) continue;
			const payload = (entry.command as { properties?: { payload?: unknown } })
				.properties?.payload;
			if (operation.get) {
				expect(deref(operation.get.responses["200"], openapi)).toEqual({
					description: "Command result",
					content: {
						"application/json": { schema: clone(entry.result) },
					},
				});
				expect(operation.get.responses["400"]).toEqual({
					$ref: "#/components/responses/ApiError",
				});
				const properties =
					(payload as { properties?: Record<string, unknown> } | undefined)
						?.properties ?? {};
				const required = new Set(
					((payload as { required?: string[] } | undefined)?.required ??
						[]) as string[],
				);
				const parameters = operation.get.parameters ?? [];
				expect(parameters.map((parameter) => parameter.name).sort()).toEqual(
					Object.keys(properties).sort(),
				);
				for (const parameter of parameters) {
					expect(parameter.in).toBe("query");
					expect(parameter.required).toBe(required.has(parameter.name));
					expect(deref(parameter.schema, openapi)).toEqual(
						clone(properties[parameter.name]),
					);
				}
			} else if (operation.post) {
				expect(deref(operation.post.responses["200"], openapi)).toEqual({
					description: "Command result",
					content: {
						"application/json": { schema: clone(entry.result) },
					},
				});
				expect(operation.post.responses["400"]).toEqual({
					$ref: "#/components/responses/ApiError",
				});
				expect(
					deref(
						operation.post.requestBody.content["application/json"].schema,
						openapi,
					),
				).toEqual(clone(payload));
			}
		}

		const asyncapi = asyncApiDocument as {
			components: {
				messages: {
					ClientToServer: { payload: unknown };
					ServerToClient: { payload: unknown };
					SseEvent: { payload: unknown };
				};
			};
		};
		expect(
			deref(asyncapi.components.messages.ClientToServer.payload, asyncapi),
		).toEqual(clone(ClientToServerSchema));
		expect(
			deref(asyncapi.components.messages.ServerToClient.payload, asyncapi),
		).toEqual(clone(ServerToClientSchema));
		expect(
			deref(asyncapi.components.messages.SseEvent.payload, asyncapi),
		).toEqual(clone(SseEventSchema));
	});
});
