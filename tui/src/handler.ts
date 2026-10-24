import type {
	CommandResultFrame,
	ServerEvent,
	TurnBlock,
} from "@cadmus/contract/types";

export const ANSI = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	cyan: "\x1b[36m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	magenta: "\x1b[35m",
	red: "\x1b[31m",
};

export interface TuiOutput {
	write(text: string): void;
	writeLine(text?: string): void;
}

export interface TuiState {
	activeChatKey?: string;
	streamingDelta: boolean;
	hasStreamedReply: boolean;
	turnBlocks: TurnBlock[];
}

export function createTuiState(initialChatKey?: string): TuiState {
	return {
		activeChatKey: initialChatKey,
		streamingDelta: false,
		hasStreamedReply: false,
		turnBlocks: [],
	};
}

export function renderBlockChips(
	blocks: readonly TurnBlock[] | undefined,
): string {
	if (!blocks || blocks.length === 0) return "";
	const chips: string[] = [];
	const seen = new Set<string>();

	for (const block of blocks) {
		if (block.type === "thinking") {
			if (!seen.has("thinking")) {
				seen.add("thinking");
				chips.push(`${ANSI.magenta}[thinking]${ANSI.reset}`);
			}
		} else if (block.type === "tool_call" && block.toolName) {
			const key = `tool:${block.toolName}`;
			if (!seen.has(key)) {
				seen.add(key);
				chips.push(`${ANSI.yellow}[tool: ${block.toolName}]${ANSI.reset}`);
			}
		}
	}

	return chips.join(" ");
}

export function handleServerEvent(
	event: ServerEvent,
	state: TuiState,
	out: TuiOutput,
): void {
	switch (event.type) {
		case "turn.delta": {
			if (
				state.activeChatKey &&
				event.payload.chatKey !== state.activeChatKey
			) {
				break;
			}
			if (event.payload.kind === "thinking") {
				const last = state.turnBlocks[state.turnBlocks.length - 1];
				if (last?.type !== "thinking") {
					state.turnBlocks.push({ type: "thinking" });
				}
				break;
			}
			if (event.payload.kind === "text") {
				state.hasStreamedReply = true;
				if (!state.streamingDelta) {
					const chips = renderBlockChips(state.turnBlocks);
					const chipsPrefix = chips.length > 0 ? `${chips} ` : "";
					out.write(`\n${ANSI.green}assistant>${ANSI.reset} ${chipsPrefix}`);
					state.streamingDelta = true;
				}
				out.write(event.payload.delta);
			}
			break;
		}
		case "turn.tool_call": {
			if (
				state.activeChatKey &&
				event.payload.chatKey !== state.activeChatKey
			) {
				break;
			}
			state.turnBlocks.push({
				type: "tool_call",
				toolName: event.payload.toolName,
			});
			if (state.streamingDelta) {
				out.write("\n");
				state.streamingDelta = false;
			}
			out.writeLine(
				`${ANSI.yellow}[tool.call]${ANSI.reset} ${event.payload.toolName}(${JSON.stringify(event.payload.args)})`,
			);
			break;
		}
		case "turn.tool_result": {
			if (
				state.activeChatKey &&
				event.payload.chatKey !== state.activeChatKey
			) {
				break;
			}
			const tag = event.payload.isError
				? `${ANSI.red}[tool.error]${ANSI.reset}`
				: `${ANSI.yellow}[tool.result]${ANSI.reset}`;
			out.writeLine(
				`${tag} ${event.payload.toolName} -> ${event.payload.content}`,
			);
			break;
		}
		case "turn.completed": {
			if (
				state.activeChatKey &&
				event.payload.chatKey !== state.activeChatKey
			) {
				break;
			}
			if (event.payload.blocks && event.payload.blocks.length > 0) {
				state.turnBlocks = event.payload.blocks;
			}
			if (state.streamingDelta) {
				out.write("\n");
				state.streamingDelta = false;
			}
			break;
		}
		case "harvest.note": {
			const files = event.payload.files.map((f) => f.path).join(", ");
			out.writeLine(
				`\n${ANSI.magenta}[harvest.note]${ANSI.reset} chat=${event.payload.chatKey} at=#${event.payload.at} files=[${files}]`,
			);
			break;
		}
		case "bot.message": {
			out.writeLine(
				`\n${ANSI.cyan}[bot.message]${ANSI.reset} ${event.payload.fromBotId} -> ${event.payload.toBotId}: ${event.payload.text}`,
			);
			break;
		}
		case "account.oauth.event": {
			const payload = event.payload;
			if (payload.status === "completed") {
				out.writeLine(
					`\n${ANSI.green}[oauth.completed]${ANSI.reset} Provider "${payload.providerId}" authorized successfully!`,
				);
			} else if (payload.status === "failed") {
				out.writeLine(
					`\n${ANSI.red}[oauth.failed]${ANSI.reset} Provider "${payload.providerId}" failed: ${payload.error?.message ?? payload.message}`,
				);
			} else if (payload.status === "cancelled") {
				out.writeLine(
					`\n${ANSI.yellow}[oauth.cancelled]${ANSI.reset} Flow for "${payload.providerId}" was cancelled.`,
				);
			} else if (payload.status === "progress") {
				out.writeLine(
					`${ANSI.cyan}[oauth.progress]${ANSI.reset} ${payload.message ?? "In progress..."}`,
				);
			}
			break;
		}
		default:
			break;
	}
}

export function handleTurnSubmitResult(
	res: CommandResultFrame<{
		reply?: string;
		text?: string;
		outOfBand?: boolean;
		blocks?: TurnBlock[];
	}>,
	state: TuiState,
	out: TuiOutput,
): void {
	if (!res.ok) {
		out.writeLine(
			`${ANSI.red}Error [${res.error?.code}]:${ANSI.reset} ${res.error?.message}`,
		);
	} else if (res.result?.outOfBand) {
		out.writeLine(`\n${ANSI.cyan}${res.result.text}${ANSI.reset}\n`);
	} else if (
		!state.hasStreamedReply &&
		(res.result?.reply !== undefined || state.turnBlocks.length > 0)
	) {
		const reply = res.result?.reply ?? "";
		const blocks = res.result?.blocks ?? state.turnBlocks;
		const chips = renderBlockChips(blocks);
		const chipsPrefix = chips.length > 0 ? (reply ? `${chips} ` : chips) : "";
		out.writeLine(
			`${ANSI.green}assistant>${ANSI.reset} ${chipsPrefix}${reply}`,
		);
	}
	state.streamingDelta = false;
	state.hasStreamedReply = false;
	state.turnBlocks = [];
}
