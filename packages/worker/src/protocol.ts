/**
 * Worker-facing protocol barrel.
 *
 * Schemas, records, and RPC types live in `@cadmus/contract`. This module
 * re-exports them and adds the backend implementations: query coercion,
 * command validation, and the JSON shim's helpers.
 * `encodePayloadQuery` is the single encoder from `@cadmus/contract/routes`.
 */

export { encodePayloadQuery } from "@cadmus/contract/routes";
export * from "@cadmus/contract/schemas";
export * from "./protocol/rest.js";
export * from "./protocol/validate.js";
