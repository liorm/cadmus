import { timingSafeEqual } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { join } from "node:path";
import type { WebConfig } from "../../config.ts";
import { getLogger } from "../../log.ts";
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

const DEV_RELOAD = `<script>
(function () {
  var version = null;
  var down = false;
  setInterval(function () {
    fetch("/dev/ui-version", { cache: "no-store" }).then(function (response) {
      if (!response.ok) throw new Error("ui version");
      return response.text();
    }).then(function (next) {
      if (down || (version !== null && version !== next)) location.reload();
      version = next;
      down = false;
    }).catch(function () {
      down = version !== null;
    });
  }, 400);
})();
</script>`;

export type WebListener = {
	readonly url: string;
	stop(): Promise<void>;
};

export async function startWeb(
	config: WebConfig,
	deps: WebDeps,
): Promise<WebListener> {
	const ui: LiveUi = { bundle: await buildUi(), version: 1, dev: config.dev };
	const stopWatch = config.dev ? watchUi(ui) : undefined;
	const server = Bun.serve({
		hostname: config.host,
		port: config.port,
		async fetch(request) {
			return handleRequest(request, config.token, deps, ui);
		},
	});
	const url = `http://${config.host}:${server.port}`;
	if (config.dev) getLogger().info("watching web ui", { url });
	return {
		url,
		async stop() {
			stopWatch?.();
			await server.stop(true);
		},
	};
}

type LiveUi = {
	bundle: { js: string; css: string };
	version: number;
	readonly dev: boolean;
};

const UI_DIR = join(import.meta.dir, "ui");

function watchUi(ui: LiveUi): () => void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let closed = false;
	const rebuild = () => {
		timer = undefined;
		if (closed) return;
		void buildUi()
			.then((bundle) => {
				if (closed) return;
				ui.bundle = bundle;
				ui.version += 1;
				getLogger().info("rebuilt web ui", { version: ui.version });
			})
			.catch((error: unknown) => {
				getLogger().error("web bundle failed", { error });
			});
	};
	const watcher: FSWatcher = watch(
		UI_DIR,
		{ recursive: true },
		(_event, name) => {
			if (!name || !/\.(tsx?|css)$/.test(name)) return;
			if (timer) clearTimeout(timer);
			timer = setTimeout(rebuild, 80);
		},
	);
	return () => {
		closed = true;
		if (timer) clearTimeout(timer);
		watcher.close();
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
	ui: LiveUi,
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
		const html = ui.dev
			? SHELL.replace("</body>", `${DEV_RELOAD}</body>`)
			: SHELL;
		return new Response(html, {
			headers: {
				"content-type": "text/html; charset=utf-8",
				...(ui.dev ? { "cache-control": "no-store" } : {}),
			},
		});
	}
	if (
		ui.dev &&
		request.method === "GET" &&
		url.pathname === "/dev/ui-version"
	) {
		return new Response(String(ui.version), {
			headers: {
				"content-type": "text/plain; charset=utf-8",
				"cache-control": "no-store",
			},
		});
	}
	if (request.method === "GET" && url.pathname === "/app.js") {
		return new Response(ui.bundle.js, {
			headers: {
				"content-type": "text/javascript; charset=utf-8",
				...(ui.dev ? { "cache-control": "no-store" } : {}),
			},
		});
	}
	if (request.method === "GET" && url.pathname === "/app.css") {
		return new Response(ui.bundle.css, {
			headers: {
				"content-type": "text/css; charset=utf-8",
				...(ui.dev ? { "cache-control": "no-store" } : {}),
			},
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
