/**
 * Drop and restore the app's `/ws` socket.
 * Chrome's `routeWebSocket` proxy can leave the page socket in CLOSING, so
 * the app never sees the drop. Obscura has no `routeWebSocket`. This gate
 * wraps `window.WebSocket` before the app boots and closes tracked sockets.
 */
import type { Page } from "@playwright/test";

type Gate = { block: boolean };

const gates = new WeakMap<Page, Gate>();

export async function installSocketGate(
	page: Page,
	options?: { blocked?: boolean },
): Promise<void> {
	const gate: Gate = { block: Boolean(options?.blocked) };
	gates.set(page, gate);
	await page.addInitScript((blocked) => {
		const native = window.WebSocket;
		const sockets: WebSocket[] = [];
		const view = window as Window & {
			__cadmusBlockWs?: boolean;
			__cadmusSockets?: WebSocket[];
		};
		view.__cadmusBlockWs = blocked;
		const http: Array<{
			url: string;
			method: string;
			body: string;
			at: number;
		}> = [];
		(
			window as Window & {
				__cadmusHttp?: typeof http;
			}
		).__cadmusHttp = http;
		const nativeFetch = window.fetch.bind(window);
		window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.toString()
						: input.url;
			const method = (
				init?.method ??
				(typeof input === "object" && "method" in input ? input.method : "GET")
			).toUpperCase();
			http.push({
				url,
				method,
				body: typeof init?.body === "string" ? init.body : "",
				at: Date.now(),
			});
			return nativeFetch(input, init);
		}) as typeof window.fetch;
		const shut = (socket: WebSocket) => {
			// Chrome can leave a worker socket in CLOSING without a close event.
			socket.dispatchEvent(new Event("close"));
			try {
				socket.close();
			} catch {
				// Already closing.
			}
		};
		(
			window as Window & { __cadmusShut?: (socket: WebSocket) => void }
		).__cadmusShut = shut;
		function Wrapped(
			this: WebSocket,
			url: string | URL,
			protocols?: string | string[],
		) {
			const socket =
				protocols === undefined ? new native(url) : new native(url, protocols);
			sockets.push(socket);
			if (view.__cadmusBlockWs) {
				// Close before the handshake so a retry cannot observe "open"
				// ahead of the gate. The close event is dispatched after the
				// caller attaches listeners.
				try {
					socket.close();
				} catch {
					// Already closed.
				}
				queueMicrotask(() => shut(socket));
			}
			return socket;
		}
		Wrapped.prototype = native.prototype;
		Object.assign(Wrapped, {
			CONNECTING: native.CONNECTING,
			OPEN: native.OPEN,
			CLOSING: native.CLOSING,
			CLOSED: native.CLOSED,
		});
		window.WebSocket = Wrapped as unknown as typeof WebSocket;
		view.__cadmusSockets = sockets;
	}, gate.block);
}

export async function dropWebSocket(page: Page): Promise<void> {
	const gate = gates.get(page);
	if (gate) gate.block = true;
	await page.evaluate(() => {
		const view = window as Window & {
			__cadmusBlockWs?: boolean;
			__cadmusSockets?: WebSocket[];
		};
		view.__cadmusBlockWs = true;
		const shut = (
			window as Window & { __cadmusShut?: (socket: WebSocket) => void }
		).__cadmusShut;
		for (const socket of view.__cadmusSockets ?? []) {
			if (shut) shut(socket);
			else {
				socket.dispatchEvent(new Event("close"));
				try {
					socket.close();
				} catch {
					// Already closed.
				}
			}
		}
	});
}

export async function restoreWebSocket(page: Page): Promise<void> {
	const gate = gates.get(page);
	if (gate) gate.block = false;
	await page.evaluate(() => {
		(window as Window & { __cadmusBlockWs?: boolean }).__cadmusBlockWs = false;
	});
}
