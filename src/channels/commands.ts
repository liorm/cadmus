import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	AgentDoc,
	defineDoc,
	defineEntry,
	type Harness,
	LiveDoc,
} from "@earendil-works/pi-durable";
import { chatFields, getLogger } from "../log.ts";
import type { ChatRecord } from "./chats.ts";

/** Commands already handled, by request key, so a redelivered `/new` never resets twice. Bounded. */
export const CommandsDoc = defineDoc<{ done: string[] }>({
	kind: "pi-bot.commands",
	version: 1,
	scope: "session",
	initial: () => ({ done: [] }),
});
const MAX_REMEMBERED = 1000;

export type Command = { name: string; args: string };

export const HELP = `Commands:
/new — start a fresh conversation (older messages stay stored but the model no longer sees them)
/stop — stop the current answer
/status — model, conversation and busy status
/help — this message`;

const KNOWN = new Set(["new", "reset", "stop", "status", "help", "start"]);

/** A command reply on a web chat. No `model` messages, so later prompts do not see it. */
export const NoticeEntry = defineEntry<{ text: string }>("pi-bot.notice");

/** `/name args`; undefined for plain text or unknown commands. */
export function parseCommand(
	text: string | undefined,
	botUsername?: string,
): Command | undefined {
	const match =
		/^\/([a-zA-Z0-9_]+)(?:@([a-zA-Z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(
			text?.trim() ?? "",
		);
	if (!match) return undefined;
	const [, rawName = "", target, args = ""] = match;
	if (
		target &&
		botUsername &&
		target.toLowerCase() !== botUsername.toLowerCase()
	)
		return undefined;
	const name = rawName.toLowerCase();
	return KNOWN.has(name) ? { name, args: args.trim() } : undefined;
}

export type CommandContext = {
	harness: Harness;
	chat: ChatRecord;
	requestKey: string;
};

/**
 * Handle a command at most once per request key: the key is claimed in a commit before the effect, so a crash between
 * the claim and the effect drops the command rather than repeating it.
 */
export async function handleCommand(
	command: Command,
	{ harness, chat, requestKey }: CommandContext,
) {
	const fresh = await harness.commit(async (tx) => {
		const commands = await tx.doc(CommandsDoc);
		if (commands.done.includes(requestKey)) return false;
		commands.done.push(requestKey);
		if (commands.done.length > MAX_REMEMBERED)
			commands.done.splice(0, commands.done.length - MAX_REMEMBERED);
		return true;
	}, BACKGROUND_CONTEXT);
	if (!fresh) return;
	getLogger()
		.child(chatFields(chat, { requestId: requestKey }))
		.debug("command", { name: command.name });
	const conversation = await harness.conversation(
		chat.conversationId,
		BACKGROUND_CONTEXT,
	);
	if (!conversation)
		throw new Error(`Conversation of chat ${chat.key} is missing`);
	const reply = (text: string) =>
		conversation.submit(
			{
				type: "write",
				requestId: `notice:${requestKey}`,
				entry: { kind: NoticeEntry.kind, data: { text } },
			},
			BACKGROUND_CONTEXT,
		);

	switch (command.name) {
		case "new":
		case "reset": {
			// While busy the reset is queued and ends the current run at its next boundary.
			await conversation.reset(command.args || undefined, BACKGROUND_CONTEXT);
			await reply("🆕 New conversation started.");
			return;
		}
		case "stop": {
			await conversation.abort(BACKGROUND_CONTEXT);
			await reply("⏹ Stopped.");
			return;
		}
		case "status": {
			const agent = await harness.snapshot(
				AgentDoc,
				chat.conversationId,
				BACKGROUND_CONTEXT,
			);
			const live = await harness.snapshot(
				LiveDoc,
				chat.conversationId,
				BACKGROUND_CONTEXT,
			);
			const model = agent?.model
				? `${agent.model.provider}/${agent.model.modelId}`
				: "(default)";
			await reply(
				[
					`Model: ${model}`,
					`Conversation: ${chat.conversationId} (chat ${chat.key})`,
					`Busy: ${live?.run ? "yes" : "no"}`,
				].join("\n"),
			);
			return;
		}
		default:
			await reply(`Hi! I'm pi-bot.\n\n${HELP}`);
	}
}
