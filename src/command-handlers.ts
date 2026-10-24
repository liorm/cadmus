import type { ClientCommand, CommandType, RpcResult } from "./protocol.js";

/**
 * One handler per command. A missing key, or a handler that reads fields the
 * payload does not have, fails typecheck.
 */
export type CommandHandler<C extends CommandType> = (
	command: Extract<ClientCommand, { type: C }>,
) => Promise<RpcResult<C>>;

export type CommandHandlerMap = {
	[C in CommandType]: CommandHandler<C>;
};

export function callCommandHandler(
	handlers: CommandHandlerMap,
	command: ClientCommand,
): Promise<RpcResult<CommandType>> {
	const handler = handlers[command.type] as (
		command: ClientCommand,
	) => Promise<RpcResult<CommandType>>;
	return handler(command);
}
