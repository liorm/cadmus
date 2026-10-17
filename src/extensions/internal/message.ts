import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";

export function messageBotTool() {
	return defineTool({
		name: "message_bot",
		description: "Send text to the bot with this slug. Not available yet.",
		parameters: Type.Object({
			slug: Type.String({ description: "Bot id to message." }),
			text: Type.String({ description: "Message text." }),
		}),
		execute() {
			throw new Error("message_bot is not implemented.");
		},
	});
}
