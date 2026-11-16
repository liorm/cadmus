/**
 * Keeps client keep-alive sockets open for the duration of Playwright tests.
 *
 * `workerd` (`wrangler dev`) closes idle HTTP/1.1 sockets after 5,000 ms, which
 * causes Obscura's `hyper` pool to hit `connection closed before message
 * completed` on subsequent navigations. This proxy holds downstream client
 * sockets open (`keepAliveTimeout = 120s`) while opening fresh loopback sockets
 * (`keepAlive: false`) to `wrangler dev` on an internal port.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";

const PUBLIC_PORT = Number(process.env.CADMUS_TEST_PUBLIC_PORT ?? "8799");
const UPSTREAM_PORT = Number(process.env.CADMUS_TEST_UPSTREAM_PORT ?? "8798");

const wranglerArgs = process.argv.slice(2);
const child = spawn(
	"bunx",
	["wrangler", "dev", ...wranglerArgs, "--port", String(UPSTREAM_PORT)],
	{ stdio: "inherit", env: process.env },
);

const upstreamAgent = new http.Agent({ keepAlive: false });

const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-connection",
	"transfer-encoding",
	"upgrade",
]);

function filterHeaders(
	headers: http.IncomingHttpHeaders,
): http.OutgoingHttpHeaders {
	const out: http.OutgoingHttpHeaders = {};
	for (const [key, value] of Object.entries(headers)) {
		if (value === undefined) continue;
		if (HOP_BY_HOP.has(key.toLowerCase())) continue;
		out[key] = value;
	}
	return out;
}

const server = http.createServer((req, res) => {
	const reqHeaders = filterHeaders(req.headers);
	if (req.headers["content-length"] !== undefined) {
		reqHeaders["content-length"] = req.headers["content-length"];
	}
	const upReq = http.request(
		{
			hostname: "127.0.0.1",
			port: UPSTREAM_PORT,
			method: req.method,
			path: req.url ?? "/",
			headers: reqHeaders,
			agent: upstreamAgent,
		},
		(upRes) => {
			const resHeaders = filterHeaders(upRes.headers);
			res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, resHeaders);
			upRes.on("error", () => {
				if (!res.destroyed) res.destroy();
			});
			upRes.pipe(res);
		},
	);
	upReq.on("error", () => {
		if (!res.headersSent) {
			const status = req.url === "/health" ? 503 : 502;
			res.writeHead(status, { "content-type": "text/plain" });
			res.end("upstream unavailable");
		} else if (!res.destroyed) {
			res.destroy();
		}
	});
	req.on("aborted", () => {
		upReq.destroy();
	});
	req.on("error", () => {
		upReq.destroy();
	});
	res.on("close", () => {
		if (!res.writableEnded) upReq.destroy();
	});
	res.on("error", () => {
		upReq.destroy();
	});
	req.pipe(upReq);
});

server.keepAliveTimeout = 120_000;
server.headersTimeout = 125_000;
server.requestTimeout = 0;

server.on("upgrade", (req, clientSocket, head) => {
	const upSocket = net.connect(UPSTREAM_PORT, "127.0.0.1");
	const clean = () => {
		if (!clientSocket.destroyed) clientSocket.destroy();
		if (!upSocket.destroyed) upSocket.destroy();
	};
	clientSocket.on("error", clean);
	upSocket.on("error", clean);
	clientSocket.on("close", () => {
		if (!upSocket.destroyed) upSocket.destroy();
	});
	upSocket.on("close", () => {
		if (!clientSocket.destroyed) clientSocket.destroy();
	});
	upSocket.once("connect", () => {
		const lines: string[] = [
			`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/${req.httpVersion}`,
		];
		for (let i = 0; i < req.rawHeaders.length; i += 2) {
			lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1] ?? ""}`);
		}
		upSocket.write(`${lines.join("\r\n")}\r\n\r\n`);
		if (head.length > 0) upSocket.write(head);
		clientSocket.pipe(upSocket);
		upSocket.pipe(clientSocket);
	});
});

function killChild(signal: NodeJS.Signals) {
	try {
		child.kill(signal);
	} catch {
		/* already gone */
	}
}

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals) {
	if (shuttingDown) return;
	shuttingDown = true;
	server.closeAllConnections?.();
	server.close();
	if (child.exitCode === null && child.signalCode === null) {
		killChild(signal);
		setTimeout(() => {
			killChild("SIGKILL");
			process.exit(0);
		}, 2_000);
	} else {
		process.exit(0);
	}
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

child.on("exit", (code) => {
	server.closeAllConnections?.();
	server.close();
	process.exit(shuttingDown ? 0 : (code ?? 0));
});

server.listen(PUBLIC_PORT);
