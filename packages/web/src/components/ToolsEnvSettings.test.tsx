import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type {
	ServerEvent,
	ToolsEnvRecord,
	ToolsEnvSecretMetaRecord,
} from "@cadmus/contract/types";
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
const USED = Date.parse("2024-06-07T08:09:10.000Z");

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

describe("ToolsEnvSettings pairing secrets", () => {
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

	it("lists secrets, cancels revoke, then confirms delete and refreshes", async () => {
		const secrets: ToolsEnvSecretMetaRecord[] = [
			{
				secretId: "hs_one",
				label: "laptop",
				kind: "daemon_token",
				updatedAt: CREATED,
				createdAt: CREATED,
				lastUsedAt: USED,
			},
			{
				secretId: "hs_two",
				kind: "daemon_token",
				updatedAt: CREATED,
				createdAt: CREATED,
			},
		];
		const envs: ToolsEnvRecord[] = [
			{
				envId: "ld_desk",
				kind: "local-daemon",
				label: "Desk",
				persist: true,
				confineToWorkspace: true,
				workspacePath: "/home/desk",
				secretId: "hs_one",
				updatedAt: CREATED,
				supportsConfinement: true,
				connection: { status: "connected" },
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
		const deletes: unknown[] = [];
		let secretLists = 0;
		let envLists = 0;
		const listeners = new Set<(event: ServerEvent) => void>();
		let allowDelete = true;

		const mockFetch: FetchFunction = async (input, init) => {
			const { type, payload } = readRequest(input, init);
			if (type === "family.list") {
				return new Response(
					JSON.stringify({
						families: [
							{
								accountId: "acc-test",
								familyId: "fam-test",
								doName: "cadmus:acc-test:fam-test",
								name: "Test Family",
								timezone: "UTC",
								harvestDelayMs: 60000,
								createdAt: CREATED,
							},
						],
					}),
				);
			}
			if (type === "bot.list") {
				return new Response(JSON.stringify({ bots: [] }));
			}
			if (type === "account.models.list") {
				return new Response(JSON.stringify({ models: [] }));
			}
			if (type === "account.toolsEnvs.list") {
				envLists += 1;
				return new Response(JSON.stringify({ default: null, envs: [...envs] }));
			}
			if (type === "account.toolsEnvSecrets.list") {
				secretLists += 1;
				return new Response(JSON.stringify({ secrets: [...secrets] }));
			}
			if (type === "account.members.list") {
				return new Response(
					JSON.stringify({
						members: [
							{
								accountId: "acc-test",
								userId: "test-user",
								role: "owner",
								createdAt: CREATED,
							},
						],
					}),
				);
			}
			if (type === "account.toolsEnvSecrets.delete") {
				deletes.push(payload);
				const secretId = (payload as { secretId?: string }).secretId;
				if (!allowDelete) {
					return new Response(
						JSON.stringify({
							error: {
								code: "not_found",
								message: `Unknown tools env secret '${secretId ?? ""}'`,
							},
						}),
						{ status: 404 },
					);
				}
				const index = secrets.findIndex(
					(secret) => secret.secretId === secretId,
				);
				if (index >= 0) secrets.splice(index, 1);
				return new Response(JSON.stringify({ deleted: secretId }));
			}
			throw new Error(`Unhandled command ${type}`);
		};

		const client = new CadmusClient({
			baseUrl: "",
			userId: "test-user",
			accountId: "acc-test",
			familyId: "fam-test",
			token: "test-token",
			fetchImpl: mockFetch,
		});
		const subscribe = client.subscribe.bind(client);
		client.subscribe = (listener) => {
			listeners.add(listener);
			const unsubscribe = subscribe(listener);
			return () => {
				listeners.delete(listener);
				unsubscribe();
			};
		};

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

		await waitForText(view, "laptop");
		expect(view.textContent).toContain("hs_one");
		expect(view.textContent).toContain("hs_two");
		expect(view.textContent).toContain("2024-01-02T03:04:05.000Z");
		expect(view.textContent).toContain("2024-06-07T08:09:10.000Z");
		expect(view.textContent).toContain("never");
		expect(view.textContent).toContain("Desk (ld_desk)");
		expect(view.textContent).toContain("No local-daemon envs use this secret.");
		expect(view.textContent).not.toContain("jb_default (");
		expect(listeners.size).toBe(1);

		const listsAfterLoad = secretLists;
		const envListsAfterLoad = envLists;
		const current = secrets[0];
		if (!current) throw new Error("missing secret");
		secrets[0] = { ...current, label: "studio-laptop" };
		await act(async () => {
			for (const listener of listeners) {
				listener({
					type: "account.tools_env_secret",
					payload: {
						accountId: "acc-test",
						secretId: "hs_one",
						action: "set",
						when: USED,
					},
				});
			}
		});
		await waitForText(view, "studio-laptop");
		expect(secretLists).toBeGreaterThan(listsAfterLoad);
		expect(envLists).toBeGreaterThan(envListsAfterLoad);

		let confirmResult = false;
		let confirmMessage = "";
		window.confirm = (message?: string) => {
			confirmMessage = String(message ?? "");
			return confirmResult;
		};

		const revoke = revokeButton(view, "hs_one");
		await act(async () => {
			revoke.click();
		});
		expect(confirmMessage).toContain("stops working immediately");
		expect(confirmMessage).toContain("Desk (ld_desk)");
		expect(deletes).toEqual([]);
		expect(view.textContent).toContain("studio-laptop");

		confirmResult = true;
		const listsBeforeDelete = secretLists;
		await act(async () => {
			revoke.click();
		});
		await waitForTextGone(view, "hs_one");
		expect(deletes).toEqual([{ secretId: "hs_one" }]);
		expect(secretLists).toBeGreaterThan(listsBeforeDelete);
		expect(view.textContent).toContain("hs_two");
		expect(view.textContent).not.toContain("studio-laptop");

		allowDelete = false;
		confirmMessage = "";
		await act(async () => {
			revokeButton(view, "hs_two").click();
		});
		await waitForText(view, "Unknown tools env secret 'hs_two'");
		expect(confirmMessage).toContain("stops working immediately");
		expect(confirmMessage).toContain("No local-daemon envs use this secret.");
		expect(deletes).toEqual([{ secretId: "hs_one" }, { secretId: "hs_two" }]);
		expect(view.textContent).toContain("hs_two");
	});

	it("disables revoke for a member and shows a friendly forbidden message", async () => {
		const secrets: ToolsEnvSecretMetaRecord[] = [
			{
				secretId: "hs_member",
				label: "laptop",
				kind: "daemon_token",
				updatedAt: CREATED,
				createdAt: CREATED,
			},
		];
		let role: "owner" | "member" = "member";
		const deletes: unknown[] = [];

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
				return new Response(JSON.stringify({ default: null, envs: [] }));
			}
			if (type === "account.toolsEnvSecrets.list") {
				return new Response(JSON.stringify({ secrets: [...secrets] }));
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
			if (type === "account.toolsEnvSecrets.delete") {
				deletes.push(payload);
				return new Response(
					JSON.stringify({
						error: { code: "forbidden", message: "forbidden" },
					}),
					{ status: 403 },
				);
			}
			throw new Error(`Unhandled command ${type}`);
		};

		const client = new CadmusClient({
			baseUrl: "",
			userId: "test-user",
			accountId: "acc-test",
			familyId: "fam-test",
			token: "test-token",
			fetchImpl: mockFetch,
		});

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

		await waitForText(view, "Only account owners can revoke");
		const revoke = revokeButton(view, "hs_member");
		expect(revoke.disabled).toBe(true);
		let confirmed = false;
		window.confirm = () => {
			confirmed = true;
			return true;
		};
		await act(async () => {
			revoke.click();
		});
		expect(confirmed).toBe(false);
		expect(deletes).toEqual([]);
		expect(view.textContent).not.toContain("forbidden");

		role = "owner";
		await act(async () => {
			root?.render(
				<CadmusProvider clientOverride={client}>
					<ToolsEnvSettings isOpen={false} onClose={() => {}} />
				</CadmusProvider>,
			);
		});
		await act(async () => {
			root?.render(
				<CadmusProvider clientOverride={client}>
					<ToolsEnvSettings isOpen onClose={() => {}} />
				</CadmusProvider>,
			);
		});
		await waitForText(view, "laptop");
		expect(view.textContent).not.toContain("Only account owners can revoke");
		await act(async () => {
			revokeButton(view, "hs_member").click();
		});
		await waitForText(view, "Only account owners can revoke pairing secrets");
		expect(view.textContent).not.toContain("forbidden");
		expect(deletes).toEqual([{ secretId: "hs_member" }]);
	});
});

function revokeButton(
	container: ParentNode,
	secretId: string,
): HTMLButtonElement {
	const button = container.querySelector(
		`button[aria-label="Revoke pairing secret ${secretId}"]`,
	);
	if (!(button instanceof HTMLButtonElement)) {
		throw new Error(`missing revoke button for ${secretId}`);
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

async function waitForTextGone(
	container: ParentNode,
	text: string,
): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		if (!container.textContent?.includes(text)) return;
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
	}
	throw new Error(`still showing ${text} in ${container.textContent ?? ""}`);
}
