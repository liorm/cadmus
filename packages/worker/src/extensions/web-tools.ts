import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { getLogger } from "../log.js";
import { unavailableToolMessage } from "../models.js";
import { toolError, toolText } from "./knowledge-tools.js";

const MAX_FETCH_CHARS = 32_000;

export function webToolsExtension() {
	return defineExtension({
		name: "cadmus.web-tools",
		tools: [
			defineTool({
				name: "web.fetch",
				// Cadmus settings read-only: HTTP GET; no FamilyStore writes.
				description:
					"Fetch a public HTTP/HTTPS URL and return its readable text content.",
				parameters: Type.Object({
					url: Type.String({ description: "HTTP or HTTPS URL to fetch." }),
				}),
				replay: "safe",
				async execute(args, api, context) {
					const prior = await api.memo<string>("body", context);
					if (prior !== undefined) {
						return toolText(prior);
					}
					let parsed: URL;
					try {
						parsed = new URL(args.url);
					} catch {
						return toolError(`Invalid URL: ${args.url}`);
					}
					if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
						return toolError("Only http: and https: URLs are supported.");
					}
					try {
						getLogger().debug("web.fetch starting", { url: parsed.toString() });
						const response = await fetch(parsed.toString(), {
							headers: {
								"User-Agent": "CadmusBot/2.0",
								Accept: "text/markdown, text/plain, text/html;q=0.9, */*;q=0.5",
							},
						});
						if (!response.ok) {
							getLogger().warn("web.fetch non-200 response", {
								url: parsed.toString(),
								status: response.status,
							});
							return toolError(
								`HTTP ${response.status} ${response.statusText} fetching ${args.url}`,
							);
						}
						const raw = await response.text();
						const text = raw
							.replace(/<script[\s\S]*?<\/script>/gi, "")
							.replace(/<style[\s\S]*?<\/style>/gi, "")
							.replace(/<[^>]+>/g, " ")
							.replace(/\s+/g, " ")
							.trim()
							.slice(0, MAX_FETCH_CHARS);
						await api.memo("body", text, context);
						getLogger().debug("web.fetch completed", {
							url: parsed.toString(),
							chars: text.length,
						});
						return toolText(text);
					} catch (error) {
						getLogger().warn("web.fetch failed", {
							url: parsed.toString(),
							error,
						});
						return toolError(
							`Failed to fetch ${args.url}: ${(error as Error).message}`,
						);
					}
				},
			}),

			defineTool({
				name: "web.search",
				// Cadmus settings read-only: provider search stub; no store writes.
				description: "Provider-native web search tool (available on xAI).",
				parameters: Type.Object({
					query: Type.Optional(Type.String()),
				}),
				replay: "safe",
				async execute(_args, api, context) {
					const agent = await api.agent(context);
					const provider = agent.model?.provider ?? "unknown";
					return toolError(unavailableToolMessage("web.search", provider));
				},
			}),

			defineTool({
				name: "x.search",
				// Cadmus settings read-only: provider search stub; no store writes.
				description:
					"Provider-native X/Twitter search tool (available on xAI).",
				parameters: Type.Object({
					query: Type.Optional(Type.String()),
				}),
				replay: "safe",
				async execute(_args, api, context) {
					const agent = await api.agent(context);
					const provider = agent.model?.provider ?? "unknown";
					return toolError(unavailableToolMessage("x.search", provider));
				},
			}),

			defineTool({
				name: "code.execute",
				description:
					"Provider-native code execution sandbox (available on xAI).",
				parameters: Type.Object({
					code: Type.Optional(Type.String()),
				}),
				replay: "safe",
				async execute(_args, api, context) {
					const agent = await api.agent(context);
					const provider = agent.model?.provider ?? "unknown";
					return toolError(unavailableToolMessage("code.execute", provider));
				},
			}),
		],
	});
}
