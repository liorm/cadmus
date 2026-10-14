import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";

const SEARCH_URL = "https://api.x.ai/v1/web/search";
const FETCH_URL = "https://api.x.ai/v1/web/fetch";

async function postJson(url: string, body: unknown): Promise<string> {
	const headers = new Headers({ "content-type": "application/json" });
	const key = process.env.XAI_API_KEY;
	if (key) headers.set("authorization", `Bearer ${key}`);
	const response = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
	const text = await response.text();
	if (!response.ok)
		throw new Error(text || `Web request failed (${response.status}).`);
	return text;
}

/**
 * `web.search` and `web.fetch` call the xAI web endpoints. Replay stays unsafe:
 * a repeated call is another request.
 */
export function webExtension() {
	return defineExtension({
		name: "pi-bot.web",
		tools: [
			defineTool({
				name: "web.search",
				description: "Search the web and return the results.",
				parameters: Type.Object({
					query: Type.String({ description: "Search query." }),
				}),
				replay: "unsafe",
				async execute(args) {
					try {
						const text = await postJson(SEARCH_URL, { query: args.query });
						return { content: [{ type: "text", text }] };
					} catch (error) {
						return {
							content: [
								{
									type: "text",
									text:
										error instanceof Error
											? error.message
											: "Web search failed.",
								},
							],
							isError: true,
						};
					}
				},
			}),
			defineTool({
				name: "web.fetch",
				description: "Fetch the text of one web page.",
				parameters: Type.Object({
					url: Type.String({ description: "Absolute URL to fetch." }),
				}),
				replay: "unsafe",
				async execute(args) {
					try {
						const text = await postJson(FETCH_URL, { url: args.url });
						return { content: [{ type: "text", text }] };
					} catch (error) {
						return {
							content: [
								{
									type: "text",
									text:
										error instanceof Error
											? error.message
											: "Web fetch failed.",
								},
							],
							isError: true,
						};
					}
				},
			}),
		],
	});
}
