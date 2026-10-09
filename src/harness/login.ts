import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";

/** Friendly names accepted by `bun run login`. */
export const PROVIDER_ALIASES: Readonly<Record<string, string>> = { grok: "xai", supergrok: "xai", "x-premium": "xai" };

export function resolveProviderId(name: string): string {
	const lower = name.trim().toLowerCase();
	return PROVIDER_ALIASES[lower] ?? lower;
}

export function describeEvent(event: AuthEvent): string {
	switch (event.type) {
		case "device_code": {
			const minutes = event.expiresInSeconds ? ` (expires in ${Math.round(event.expiresInSeconds / 60)} min)` : "";
			return `Open this URL in any browser (phone or laptop) and sign in:\n\n  ${event.verificationUri}\n\nIf asked, enter the code: ${event.userCode}${minutes}\nWaiting for approval…`;
		}
		case "auth_url":
			return `Open this URL in a browser:\n\n  ${event.url}\n${event.instructions ? `\n${event.instructions}` : ""}`;
		case "info":
			return [event.message, ...(event.links ?? []).map((link) => `  ${link.label ?? ""} ${link.url}`.trimEnd())].join("\n");
		case "progress":
			return event.message;
	}
}

/**
 * Run a provider's OAuth login (xAI: RFC 8628 device code, no local browser or callback port needed) and store the
 * credential in the Models' credential store.
 */
export async function loginProvider(
	models: MutableModels,
	providerId: string,
	io: { print(text: string): void; ask(prompt: AuthPrompt): Promise<string>; signal?: AbortSignal },
): Promise<void> {
	const provider = models.getProvider(providerId);
	if (!provider) throw new Error(`Unknown provider "${providerId}"`);
	if (!provider.auth.oauth?.login) throw new Error(`${provider.name} has no OAuth login; use its API key env var instead`);
	const interaction: AuthInteraction = {
		...(io.signal ? { signal: io.signal } : {}),
		notify: (event) => io.print(describeEvent(event)),
		prompt: (prompt) => io.ask(prompt),
	};
	await models.login(providerId, "oauth", interaction, { agentName: "pi-bot" });
}
