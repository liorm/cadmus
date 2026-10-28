import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ToolsEnvRecord } from "@cadmus/contract/types";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CadmusClient, type FetchFunction } from "../client.js";
import { CadmusProvider } from "../context/CadmusContext.js";
import {
	commandTypeFromApiPath,
	decodePayloadQuery,
} from "../read-api-request.js";
import { ToolsEnvSettings } from "./ToolsEnvSettings.js";

if (typeof document === "undefined") {
	GlobalRegistrator.register();
}
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const CREATED = Date.parse("2024-01-02T03:04:05.000Z");

class SilentWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	readyState = SilentWebSocket.CONNECTING;
	url: string;
	constructor(url: string) {
		this.url = url;
	}
	addEventListener(): void {}
	removeEventListener(): void {}
	send(): void {}
	close(): void {
		this.readyState = SilentWebSocket.CLOSED;
	}
}

function readRequest(
	input: RequestInfo | URL,
	init?: RequestInit,
): { type: string; payload: unknown } {
	const url = new URL(String(input), "http://cadmus.test");
	const type = commandTypeFromApiPath(url.pathname);
	if (!type) throw new Error(`Unexpected API path ${url.pathname}`);
	const method = (init?.method ?? "GET").toUpperCase();
	if (method === "GET" || method === "HEAD") {
		return { type, payload: decodePayloadQuery(url.searchParams) };
	}
	const raw = typeof init?.body === "string" ? init.body : "";
	return {
		type,
		payload: raw.trim().length === 0 ? {} : JSON.parse(raw),
	};
}

const PAIR_COMMAND = `cadmus-daemon pair cadmus_pt_${"a".repeat(80)}`;

const envs: ToolsEnvRecord[] = [
	{
		envId: "ld_desk",
		kind: "local-daemon",
		label: "Desk",
		persist: true,
		confineToWorkspace: true,
		updatedAt: CREATED,
		supportsConfinement: true,
		connection: { status: "connected", workspacePath: "/home/desk" },
	},
	{
		envId: "jb_default",
		kind: "just-bash",
		persist: true,
		confineToWorkspace: true,
		updatedAt: CREATED,
		supportsConfinement: true,
		connection: { status: "connected" },
	},
];

function clientFor(
	role: "owner" | "member",
	onDeregister?: (payload: unknown) => Response,
): CadmusClient {
	const mockFetch: FetchFunction = async (input, init) => {
		const { type, payload } = readRequest(input, init);
		if (type === "family.list") {
			return new Response(JSON.stringify({ families: [] }));
		}
		if (type === "bot.list") {
			return new Response(JSON.stringify({ bots: [] }));
		}
		if (type === "account.models.list") {
			return new Response(JSON.stringify({ models: [] }));
		}
		if (type === "account.toolsEnvs.list") {
			return new Response(JSON.stringify({ default: null, envs }));
		}
		if (type === "account.members.list") {
			return new Response(
				JSON.stringify({
					members: [
						{
							accountId: "acc-test",
							userId: "test-user",
							role,
							createdAt: CREATED,
						},
					],
				}),
			);
		}
		if (type === "account.toolsEnvs.deregister") {
			return (
				onDeregister?.(payload) ??
				new Response(JSON.stringify({ deregistered: "ld_desk" }))
			);
		}
		if (type === "account.toolsEnvs.pair") {
			return new Response(
				JSON.stringify({
					envId: "ld_desk",
					pairingToken: "cadmus_pt_test",
					expiresAt: CREATED + 900_000,
					command: PAIR_COMMAND,
				}),
			);
		}
		throw new Error(`Unhandled command ${type}`);
	};
	return new CadmusClient({
		baseUrl: "",
		userId: "test-user",
		accountId: "acc-test",
		familyId: "fam-test",
		token: "test-token",
		fetchImpl: mockFetch,
	});
}

describe("ToolsEnvSettings daemon lifecycle", () => {
	let root: Root | undefined;
	let container: HTMLDivElement | undefined;
	const previousWebSocket = globalThis.WebSocket;
	const previousConfirm = globalThis.confirm;

	beforeEach(() => {
		globalThis.WebSocket = SilentWebSocket as unknown as typeof WebSocket;
	});

	afterEach(() => {
		root?.unmount();
		container?.remove();
		root = undefined;
		container = undefined;
		globalThis.WebSocket = previousWebSocket;
		globalThis.confirm = previousConfirm;
	});

	async function render(client: CadmusClient) {
		const view = document.createElement("div");
		container = view;
		document.body.appendChild(view);
		root = createRoot(view);
		await act(async () => {
			root?.render(
				<CadmusProvider clientOverride={client}>
					<ToolsEnvSettings isOpen onClose={() => {}} />
				</CadmusProvider>,
			);
		});
		return view;
	}

	it("lists envs and deregisters a daemon after confirm", async () => {
		const deletes: unknown[] = [];
		const view = await render(
			clientFor("owner", (payload) => {
				deletes.push(payload);
				return new Response(JSON.stringify({ deregistered: "ld_desk" }));
			}),
		);
		await waitForText(view, "ld_desk");
		expect(view.textContent).toContain("Desk");
		expect(view.textContent).not.toContain("Pairing secrets");
		expect(deregisterButton(view, "jb_default", "env")).toBeInstanceOf(
			HTMLButtonElement,
		);

		let confirmResult = false;
		let confirmMessage = "";
		window.confirm = (message?: string) => {
			confirmMessage = String(message ?? "");
			return confirmResult;
		};
		const button = deregisterButton(view, "ld_desk");
		await act(async () => {
			button.click();
		});
		expect(confirmMessage).toContain("stops working immediately");
		expect(deletes).toEqual([]);

		confirmResult = true;
		await act(async () => {
			button.click();
		});
		expect(deletes).toEqual([{ envId: "ld_desk" }]);

		confirmMessage = "";
		await act(async () => {
			deregisterButton(view, "jb_default", "env").click();
		});
		expect(confirmMessage).toBe("Deregister env jb_default?");
		expect(confirmMessage).not.toContain("token");
		expect(deletes).toEqual([{ envId: "ld_desk" }, { envId: "jb_default" }]);
	});

	it("wraps the pairing command and copies the full string", async () => {
		const view = await render(clientFor("owner"));
		await waitForText(view, "ld_desk");
		const pair = [...view.querySelectorAll("button")].find(
			(button) => button.textContent === "Pair",
		);
		if (!(pair instanceof HTMLButtonElement)) {
			throw new Error("missing pair button");
		}
		await act(async () => {
			pair.click();
		});
		await waitForText(view, PAIR_COMMAND);
		const code = view.querySelector("code.input-mono");
		if (!(code instanceof HTMLElement)) {
			throw new Error("missing pairing command");
		}
		expect(code.style.overflowWrap).toBe("anywhere");
		expect(code.style.wordBreak).toBe("break-all");
		expect(code.textContent).toBe(PAIR_COMMAND);
		let copied = "";
		const clipboard = navigator.clipboard;
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: async (value: string) => {
					copied = value;
				},
			},
		});
		const copy = [...view.querySelectorAll("button")].find(
			(button) => button.textContent === "Copy Command",
		);
		if (!(copy instanceof HTMLButtonElement)) {
			throw new Error("missing copy button");
		}
		await act(async () => {
			copy.click();
		});
		expect(copied).toBe(PAIR_COMMAND);
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: clipboard,
		});
	});

	it("hides deregister from members and shows the owner hint", async () => {
		const view = await render(clientFor("member"));
		await waitForText(view, "Only account owners can deregister an env");
		expect(view.textContent).toContain("ld_desk");
		expect(view.querySelector("button[aria-label^='Deregister']")).toBeNull();
		expect(view.textContent).not.toContain("Pairing secrets");
	});

	it("shows a friendly message when deregister is forbidden", async () => {
		const view = await render(
			clientFor("owner", () => {
				return new Response(
					JSON.stringify({
						error: { code: "forbidden", message: "forbidden" },
					}),
					{ status: 403 },
				);
			}),
		);
		await waitForText(view, "ld_desk");
		window.confirm = () => true;
		await act(async () => {
			deregisterButton(view, "ld_desk").click();
		});
		await waitForText(view, "Only account owners can deregister an env");
		expect(view.textContent).not.toContain("forbidden");
	});
});

function deregisterButton(
	container: ParentNode,
	envId: string,
	kind: "daemon" | "env" = "daemon",
): HTMLButtonElement {
	const button = container.querySelector(
		`button[aria-label="Deregister ${kind} ${envId}"]`,
	);
	if (!(button instanceof HTMLButtonElement)) {
		throw new Error(`missing deregister button for ${envId}`);
	}
	return button;
}

async function waitForText(container: ParentNode, text: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		if (container.textContent?.includes(text)) return;
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
	}
	throw new Error(`missing ${text} in ${container.textContent ?? ""}`);
}
