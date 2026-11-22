import type { JsonValue } from "@earendil-works/chord";
import {
	defineExtension,
	defineTool,
	section,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { requireCadmusServices } from "../context.js";
import type { CadmusExtensionDescriptor } from "./cadmus-tools.js";
import { resolveBotScope, toolError, toolText } from "./file-tools.js";

export const GROUP_CALLER_PROMPT = `CRITICAL - YOU ARE IN AN AUTOMATED SUB-CONVERSATION WITH PEER BOTS:
- The human user is NOT in this conversation. All incoming messages are from peer bots.
- You initiated this group chat using message_bot to query peer bot(s).
- Never ask questions to the user here, never send conversational pleasantries ('Understood', 'Got it', '👍'), and do not attempt to start another group chat.
- Your SOLE objective is to evaluate the peer's reply and call the end_conversation({ response: "..." }) tool immediately.
- As soon as the peer bot answers your question, or confirms it has no records/knowledge, you MUST call end_conversation immediately with the summary response so your main conversation with the user can resume.`;

export function groupCallerExtension() {
	return defineExtension({
		name: "cadmus.group-caller",
		sections: [section("group-caller", () => GROUP_CALLER_PROMPT)],
		tools: [
			defineTool({
				name: "end_conversation",
				description:
					"End the group chat you started and return this response to your waiting message_bot call. Offered only in that caller session. When you initiated a group chat with message_bot, you MUST call end_conversation immediately once the target bot provides the answer or confirms it has no information. Do NOT reply with chit-chat, 'Understood', 'Got it', or pleasantries as regular messages, because each message requires another turn from the peer until hitting the 10-turn cap.",
				parameters: Type.Object({
					response: Type.String({
						minLength: 1,
						description:
							"Summary or final response to return to the waiting caller session.",
					}),
				}),
				replay: "safe",
				executionMode: "sequential",
				async execute(args, api, context) {
					const prior = await api.memo<JsonValue>("result", context);
					if (prior !== undefined) return toolText(JSON.stringify(prior));
					const scope = await resolveBotScope(api, context);
					if (!scope?.chatKey) {
						return toolError("Conversation is not bound to a bot.");
					}
					const services = requireCadmusServices(context);
					if (!services.isGroupCallerSession(scope.chatKey)) {
						return toolError(
							"end_conversation is only available in a group chat you started.",
						);
					}
					const ended = services.endGroupConversation(
						scope.chatKey,
						args.response,
					);
					if (!ended) {
						return toolError("This group chat is not open.");
					}
					const payload = { response: args.response, ended: true };
					await api.memo("result", payload, context);
					return toolText(JSON.stringify(payload));
				},
			}),
		],
	});
}

export function groupCallerExtensionDescriptor(): CadmusExtensionDescriptor {
	return {
		extension: groupCallerExtension(),
		defaultEnabled: false,
		allowlistPolicy: { mode: "always" },
		isActive: (ctx) => ctx.isGroupCaller,
	};
}
