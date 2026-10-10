import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { WebConfig } from "../../config.ts";
import { handleApi, type WebDeps } from "./api.ts";

const SHELL = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>pi-bot</title>
<script>
try {
  var t = localStorage.getItem("pi-bot.theme");
  document.documentElement.dataset.theme =
    t === "light" || t === "fire" ? t : "dark";
} catch (e) {
  document.documentElement.dataset.theme = "dark";
}
</script>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<div id="root"></div>
<script type="module" src="/app.js"></script>
</body>
</html>
`;

export type WebListener = {
	readonly url: string;
	stop(): Promise<void>;
};

export async function startWeb(
	config: WebConfig,
	deps: WebDeps,
): Promise<WebListener> {
	const bundle = await buildUi();
	const server = Bun.serve({
		hostname: config.host,
		port: config.port,
		async fetch(request) {
			return handleRequest(request, config.token, deps, bundle);
		},
	});
	const url = `http://${config.host}:${server.port}`;
	return {
		url,
		async stop() {
			await server.stop(true);
		},
	};
}

// Set only by `bun run build:binary` (`scripts/build-binary.ts`). Absent under `bun start`.
declare const PI_BOT_EMBEDDED_UI:
	| { readonly js: string; readonly css: string }
	| undefined;

async function buildUi(): Promise<{ js: string; css: string }> {
	if (typeof PI_BOT_EMBEDDED_UI !== "undefined") return PI_BOT_EMBEDDED_UI;
	const built = await Bun.build({
		entrypoints: [join(import.meta.dir, "ui/main.tsx")],
		target: "browser",
		format: "esm",
		tsconfig: join(import.meta.dir, "../../../tsconfig.web.json"),
		jsx: { runtime: "automatic", importSource: "preact", development: false },
	});
	if (!built.success)
		throw new Error(
			built.logs.map((log) => log.message).join("\n") || "web bundle failed",
		);
	let js = "";
	let css = "";
	for (const output of built.outputs) {
		if (output.path.endsWith(".css")) css = await output.text();
		else if (output.path.endsWith(".js")) js += await output.text();
	}
	if (!js) throw new Error("web bundle produced no script");
	return { js, css };
}

async function handleRequest(
	request: Request,
	token: string,
	deps: WebDeps,
	bundle: { js: string; css: string },
): Promise<Response> {
	const url = new URL(request.url);
	if (
		request.method === "GET" &&
		url.pathname === "/" &&
		url.searchParams.has("token")
	) {
		if (!sameToken(url.searchParams.get("token") ?? "", token))
			return unauthorized();
		return new Response(null, {
			status: 302,
			headers: {
				location: "/",
				"set-cookie": `token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`,
			},
		});
	}
	if (!authorized(request, token)) return unauthorized();
	if (request.method === "GET" && url.pathname === "/") {
		return new Response(SHELL, {
			headers: { "content-type": "text/html; charset=utf-8" },
		});
	}
	if (request.method === "GET" && url.pathname === "/app.js") {
		return new Response(bundle.js, {
			headers: { "content-type": "text/javascript; charset=utf-8" },
		});
	}
	if (request.method === "GET" && url.pathname === "/app.css") {
		return new Response(bundle.css, {
			headers: { "content-type": "text/css; charset=utf-8" },
		});
	}
	if (url.pathname.startsWith("/api/")) return handleApi(request, deps);
	return new Response("Not found.", { status: 404 });
}

function authorized(request: Request, token: string): boolean {
	const header = request.headers.get("authorization");
	const bearer = header?.toLowerCase().startsWith("bearer ")
		? header.slice("bearer ".length).trim()
		: undefined;
	return (
		sameToken(bearer, token) ||
		sameToken(cookieToken(request.headers.get("cookie")), token)
	);
}

function cookieToken(header: string | null): string | undefined {
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		if (part.slice(0, eq).trim() !== "token") continue;
		try {
			return decodeURIComponent(part.slice(eq + 1).trim());
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function sameToken(presented: string | undefined, expected: string): boolean {
	if (presented === undefined) return false;
	const left = Buffer.from(presented);
	const right = Buffer.from(expected);
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

function unauthorized(): Response {
	return Response.json({ error: "unauthorized" }, { status: 401 });
}
