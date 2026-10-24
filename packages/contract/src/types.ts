/**
 * Types only. This module has no runtime exports.
 * Clients import it as `@cadmus/contract/types`.
 */
export type * from "./catalog.js";
export type * from "./commands.js";
export type * from "./common.js";
export type * from "./errors.js";
export type * from "./frames.js";
export type * from "./messages.js";
export type * from "./oauth.js";
export type * from "./records.js";
export type * from "./results.js";
export type * from "./rpc.js";

import type { CommandType } from "./commands.js";
import type { RpcPayload, RpcResult } from "./rpc.js";

export type CommandName = CommandType;
export type Payload<C extends CommandName> = RpcPayload<C>;
export type Result<C extends CommandName> = RpcResult<C>;
