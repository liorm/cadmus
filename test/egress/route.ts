// Rewrites requests to real egress hosts onto a FakeEgress server. Anything else that leaves the process fails loudly.
const ROUTES: [string, string][] = [
	["https://api.telegram.org/", "/telegram/"],
	["https://api.x.ai/", "/xai-api/"],
	["https://auth.x.ai/", "/xai-auth/"],
];

export function routeEgress(base: string): () => void {
	const original = globalThis.fetch;
	const routed = (async (input: string | URL | Request, init?: RequestInit) => {
		const request = input instanceof Request ? input : new Request(input.toString(), init);
		if (request.url.startsWith(base)) return original(request);
		for (const [prefix, path] of ROUTES)
			if (request.url.startsWith(prefix)) return original(new Request(base + path + request.url.slice(prefix.length), request));
		throw new Error(`Unmocked egress in test: ${request.method} ${request.url}`);
	}) as typeof fetch;
	globalThis.fetch = routed;
	return () => {
		if (globalThis.fetch === routed) globalThis.fetch = original;
	};
}
