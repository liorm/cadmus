import { describe, expect, it } from "vitest";
import {
	addMemberBearer,
	callApi,
	commandCatalog,
	elevateAccessToken,
	loginDevPassword,
	provisionInvitedMember,
	sendRpc,
	useWorkerFixture,
	WORKER_BASE_URL,
	workerFetch,
} from "./helpers.js";

/**
 * Command × role × transport. Grant sets are literals (e2e cannot import
 * `@cadmus/contract/grants`). A denial is `forbidden` or `elevation_required`.
 * Allowed commands are not part of the sweep. Super-admin has no `chat.use`,
 * so `/ws` is the refusal to mint `auth.ticket`.
 *
 * Sessions are dev-password access tokens. A `user` role holds `USER`, not a
 * custom grant subset. `tokens.manage` is not a grant.
 */
const USER = [
	"chat.use",
	"bot.read",
	"bot.write",
	"bot.delete",
	"family.manage",
	"knowledge.write",
	"schedule.write",
	"files.write",
	"members.read",
	"credentials.read",
	"toolsEnv.read",
	"toolsEnv.manage",
	"tokens.self",
	"session.assume",
] as const;

const ACCOUNT_ADMIN = [
	...USER,
	"members.manage",
	"credentials.manage",
	"account.manage",
	"audit.read",
	"admin.elevate",
] as const;

const SUPER_ADMIN = [
	"tokens.self",
	"system.accounts.read",
	"system.accounts.manage",
	"system.members.manage",
	"system.users.manage",
	"system.audit.read",
	"admin.elevate",
	"session.assume",
] as const;

const ELEVATION = new Set([
	"members.manage",
	"credentials.manage",
	"account.manage",
	"system.accounts.manage",
	"system.members.manage",
	"system.users.manage",
]);

type SchemaNode = {
	const?: unknown;
	enum?: unknown[];
	anyOf?: SchemaNode[];
	oneOf?: SchemaNode[];
	type?: string;
	format?: string;
	minLength?: number;
	minimum?: number;
	minItems?: number;
	items?: SchemaNode;
	properties?: Record<string, SchemaNode>;
	required?: string[];
	grant?: string;
};

const catalog = commandCatalog as unknown as Record<
	string,
	{ command: SchemaNode }
>;

function commandTypes(): string[] {
	return Object.keys(catalog);
}

function minimal(schema: SchemaNode | undefined): unknown {
	if (!schema) return {};
	if (schema.const !== undefined) return schema.const;
	if (schema.enum) return schema.enum[0];
	if (schema.anyOf) return minimal(schema.anyOf[0]);
	if (schema.oneOf) return minimal(schema.oneOf[0]);
	switch (schema.type) {
		case "string":
			if (schema.format === "email") return "matrix@example.com";
			return "x".repeat(Math.max(1, schema.minLength ?? 1));
		case "number":
		case "integer":
			return schema.minimum ?? 1;
		case "boolean":
			return false;
		case "array":
			return Array.from({ length: schema.minItems ?? 0 }, () =>
				minimal(schema.items),
			);
		default: {
			const out: Record<string, unknown> = {};
			for (const key of schema.required ?? []) {
				out[key] = minimal(schema.properties?.[key]);
			}
			return out;
		}
	}
}

function payloadFor(type: string): Record<string, unknown> {
	const payload = (minimal(catalog[type]?.command.properties?.payload) ??
		{}) as Record<string, unknown>;
	if ("familyId" in payload) payload.familyId = "default";
	return payload;
}

function expectedCode(
	held: Set<string>,
	grant: string,
	elevated: boolean,
	tokenCaller: boolean,
): "forbidden" | "elevation_required" | null {
	if (!held.has(grant)) return "forbidden";
	if (ELEVATION.has(grant) && !elevated && !tokenCaller) {
		return "elevation_required";
	}
	return null;
}

type Frame = { ok: boolean; error?: { code?: string }; result?: unknown };

function codeOf(frame: Frame): string {
	return frame.ok ? "ok" : (frame.error?.code ?? "error");
}

async function api(
	token: string,
	type: string,
	payload: Record<string, unknown>,
): Promise<Frame> {
	return callApi(type, payload, { token });
}

async function rpc(
	token: string,
	type: string,
	payload: Record<string, unknown>,
): Promise<Frame> {
	const res = await sendRpc(type, payload, { token });
	return res.frame;
}

const WS_REPLY_MS = 5_000;

async function openWs(token: string, who: string) {
	const issued = await sendRpc<{ ticket: string }>(
		"auth.ticket",
		{ target: "ws" },
		{ token },
	);
	if (!issued.frame.ok || !issued.frame.result?.ticket) {
		throw new Error(
			`could not mint a ws ticket for ${who}: ${JSON.stringify(issued.frame)}`,
		);
	}
	const res = await workerFetch(
		`${WORKER_BASE_URL}/ws?ticket=${encodeURIComponent(issued.frame.result.ticket)}`,
		{ headers: { Upgrade: "websocket" } },
	);
	const ws = res.webSocket;
	if (!ws)
		throw new Error(`websocket upgrade failed for ${who}: ${res.status}`);
	ws.accept();
	const pending = new Map<string, (frame: Frame) => void>();
	ws.addEventListener("message", (ev) => {
		const raw =
			typeof ev.data === "string"
				? ev.data
				: new TextDecoder().decode(ev.data as ArrayBuffer);
		const frame = JSON.parse(raw) as Frame & { id?: string };
		if (frame.id) pending.get(frame.id)?.(frame);
	});
	return {
		close: () => {
			try {
				ws.close();
			} catch {
				// The socket may already be gone.
			}
		},
		call: (type: string, payload: Record<string, unknown>) =>
			new Promise<Frame>((resolve, reject) => {
				const id = crypto.randomUUID();
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(
						new Error(
							`/ws reply not received within ${WS_REPLY_MS}ms: ${who} ${type}`,
						),
					);
				}, WS_REPLY_MS);
				pending.set(id, (frame) => {
					clearTimeout(timer);
					pending.delete(id);
					resolve(frame);
				});
				ws.send(JSON.stringify({ id, type, payload }));
			}),
	};
}

interface Caller {
	name: string;
	token: string;
	held: Set<string>;
	elevated: boolean;
	tokenCaller: boolean;
	denied: number;
	elevationRequired: number;
	forbidden: number;
	ws: boolean;
}

function denials(caller: Caller): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	for (const type of commandTypes()) {
		const grant = catalog[type]?.command.grant;
		if (!grant) continue;
		const code = expectedCode(
			caller.held,
			grant,
			caller.elevated,
			caller.tokenCaller,
		);
		if (code) out.push([type, code]);
	}
	return out;
}

async function sweep(
	caller: Caller,
	snapshot: () => Promise<string>,
	positive: () => Promise<void>,
): Promise<void> {
	const denied = denials(caller);
	const elevationRequired = denied.filter(
		([, code]) => code === "elevation_required",
	).length;
	const forbidden = denied.filter(([, code]) => code === "forbidden").length;
	expect(commandTypes().length).toBe(91);
	expect(denied.length, caller.name).toBe(caller.denied);
	expect(elevationRequired, caller.name).toBe(caller.elevationRequired);
	expect(forbidden, caller.name).toBe(caller.forbidden);
	const before = await snapshot();
	const wrongApi: string[] = [];
	const wrongRpc: string[] = [];
	for (const [type, code] of denied) {
		const payload = payloadFor(type);
		const viaApi = codeOf(await api(caller.token, type, payload));
		if (viaApi !== code)
			wrongApi.push(`${type}: expected ${code}, got ${viaApi}`);
		const viaRpc = codeOf(await rpc(caller.token, type, payload));
		if (viaRpc !== code)
			wrongRpc.push(`${type}: expected ${code}, got ${viaRpc}`);
	}
	expect(wrongApi, `${caller.name} /api`).toEqual([]);
	expect(wrongRpc, `${caller.name} /rpc`).toEqual([]);
	if (caller.ws) {
		const socket = await openWs(caller.token, caller.name);
		const wrongWs: string[] = [];
		try {
			for (const [type, code] of denied) {
				const viaWs = codeOf(await socket.call(type, payloadFor(type)));
				if (viaWs !== code)
					wrongWs.push(`${type}: expected ${code}, got ${viaWs}`);
			}
		} finally {
			socket.close();
		}
		expect(wrongWs, `${caller.name} /ws`).toEqual([]);
	} else {
		const ticket = await rpc(caller.token, "auth.ticket", { target: "ws" });
		expect(codeOf(ticket), `${caller.name} auth.ticket`).toBe("forbidden");
	}
	const after = await snapshot();
	expect(after, `${caller.name} state`).toBe(before);
	await positive();
}

async function sessionId(token: string): Promise<string> {
	const listed = await sendRpc<{
		sessions: { id: string; current: boolean }[];
	}>("auth.sessions.list", {}, { token });
	expect(listed.frame.ok, JSON.stringify(listed.frame)).toBe(true);
	const current = listed.frame.result?.sessions.find((row) => row.current);
	if (!current) throw new Error("no current session");
	return current.id;
}

function stripReaderAudit(value: unknown, readerSession: string): unknown {
	if (!value || typeof value !== "object") return value;
	const events = (value as { events?: { action?: string; target?: string }[] })
		.events;
	if (!events) return value;
	return {
		...(value as Record<string, unknown>),
		events: events.filter(
			(event) =>
				!(
					event.target === readerSession &&
					(event.action ?? "").startsWith("elevated.command")
				),
		),
	};
}

async function tenantSnapshot(reader: string): Promise<string> {
	const readerSession = await sessionId(reader);
	const out: Record<string, unknown> = {};
	for (const type of [
		"account.members.list",
		"account.invites.list",
		"bot.list",
		"account.get",
		"account.audit.list",
	]) {
		const frame = await rpc(reader, type, {});
		out[type] = frame.ok
			? frame.result
			: `refused:${frame.error?.code ?? "error"}`;
	}
	out["account.audit.list"] = stripReaderAudit(
		out["account.audit.list"],
		readerSession,
	);
	return JSON.stringify(out);
}

async function systemSnapshot(token: string): Promise<string> {
	const accounts = await rpc(token, "system.accounts.list", {});
	const audit = await rpc(token, "system.audit.list", {});
	const who = await rpc(token, "auth.whoami", {});
	return JSON.stringify({
		accounts: accounts.ok ? accounts.result : accounts.error?.code,
		audit: audit.ok ? audit.result : audit.error?.code,
		who: who.ok ? who.result : who.error?.code,
	});
}

describe("authorization matrix over /api, /rpc, and /ws", () => {
	useWorkerFixture();

	async function setupTenant() {
		const admin = await provisionInvitedMember({ role: "account-admin" });
		const boss = await loginDevPassword();
		await elevateAccessToken(boss.accessToken);
		const email = `user-${crypto.randomUUID()}@example.com`;
		const invite = await sendRpc(
			"system.members.invite",
			{ accountId: admin.accountId, email, roles: ["user"] },
			{ token: boss.accessToken },
		);
		expect(invite.frame.ok, JSON.stringify(invite.frame)).toBe(true);
		const user = await loginDevPassword(email);
		const elevated = await loginDevPassword(admin.email);
		await elevateAccessToken(elevated.accessToken);
		const warm = await rpc(admin.accessToken, "family.list", {});
		expect(codeOf(warm), "warm family.list").toBe("ok");
		return {
			accountId: admin.accountId,
			accountName: admin.accountName,
			userToken: user.accessToken,
			adminToken: admin.accessToken,
			elevatedToken: elevated.accessToken,
		};
	}

	it("a user is refused the commands outside the user grant set", async () => {
		const tenant = await setupTenant();
		await sweep(
			{
				name: "user",
				token: tenant.userToken,
				held: new Set(USER),
				elevated: false,
				tokenCaller: false,
				denied: 32,
				elevationRequired: 0,
				forbidden: 32,
				ws: true,
			},
			() => tenantSnapshot(tenant.elevatedToken),
			async () => {
				expect(codeOf(await rpc(tenant.userToken, "bot.list", {}))).toBe("ok");
			},
		);
	}, 180_000);

	it("an unelevated account-admin is refused elevated and system commands", async () => {
		const tenant = await setupTenant();
		await sweep(
			{
				name: "account-admin",
				token: tenant.adminToken,
				held: new Set(ACCOUNT_ADMIN),
				elevated: false,
				tokenCaller: false,
				denied: 29,
				elevationRequired: 13,
				forbidden: 16,
				ws: true,
			},
			() => tenantSnapshot(tenant.elevatedToken),
			async () => {
				expect(codeOf(await rpc(tenant.adminToken, "bot.list", {}))).toBe("ok");
				expect(
					codeOf(
						await rpc(tenant.adminToken, "account.update", {
							name: "Blocked",
						}),
					),
				).toBe("elevation_required");
			},
		);
	}, 180_000);

	it("an elevated account-admin is refused only system commands", async () => {
		const tenant = await setupTenant();
		await sweep(
			{
				name: "elevated account-admin",
				token: tenant.elevatedToken,
				held: new Set(ACCOUNT_ADMIN),
				elevated: true,
				tokenCaller: false,
				denied: 16,
				elevationRequired: 0,
				forbidden: 16,
				ws: true,
			},
			() => tenantSnapshot(tenant.elevatedToken),
			async () => {
				expect(
					codeOf(await rpc(tenant.elevatedToken, "system.accounts.list", {})),
				).toBe("forbidden");
			},
		);
	}, 180_000);

	it("a user-role dev-password session holds the user grants, not a subset", async () => {
		const tenant = await setupTenant();
		const member = await addMemberBearer({
			accountId: tenant.accountId,
			role: "user",
		});
		expect(member.token.startsWith("cad_at_")).toBe(true);
		await sweep(
			{
				name: "user-role session",
				token: member.token,
				held: new Set(USER),
				elevated: false,
				tokenCaller: false,
				denied: 32,
				elevationRequired: 0,
				forbidden: 32,
				ws: true,
			},
			() => tenantSnapshot(tenant.elevatedToken),
			async () => {
				expect(codeOf(await rpc(member.token, "chat.list", {}))).toBe("ok");
				expect(codeOf(await rpc(member.token, "bot.list", {}))).toBe("ok");
				const who = await rpc(member.token, "auth.whoami", {});
				expect(codeOf(who)).toBe("ok");
				const principal = (
					who.result as { principal?: { kind?: string } } | undefined
				)?.principal;
				expect(principal?.kind).toBe("user");
				expect(principal).not.toHaveProperty("viaToken");
			},
		);
	}, 180_000);

	it("an unelevated super-admin is refused tenant data and elevated system commands", async () => {
		const boss = await loginDevPassword();
		await rpc(boss.accessToken, "family.list", {});
		await sweep(
			{
				name: "super-admin",
				token: boss.accessToken,
				held: new Set(SUPER_ADMIN),
				elevated: false,
				tokenCaller: false,
				denied: 68,
				elevationRequired: 12,
				forbidden: 56,
				ws: false,
			},
			() => systemSnapshot(boss.accessToken),
			async () => {
				expect(
					codeOf(await rpc(boss.accessToken, "system.accounts.list", {})),
				).toBe("ok");
				expect(
					codeOf(
						await rpc(boss.accessToken, "system.accounts.create", {
							name: "Not yet",
							ownerEmail: "not-yet@example.com",
						}),
					),
				).toBe("elevation_required");
				expect(codeOf(await rpc(boss.accessToken, "bot.list", {}))).toBe(
					"forbidden",
				);
			},
		);
	}, 180_000);

	it("an elevated super-admin is refused tenant data", async () => {
		const boss = await loginDevPassword();
		await elevateAccessToken(boss.accessToken);
		await rpc(boss.accessToken, "family.list", {});
		await sweep(
			{
				name: "elevated super-admin",
				token: boss.accessToken,
				held: new Set(SUPER_ADMIN),
				elevated: true,
				tokenCaller: false,
				denied: 56,
				elevationRequired: 0,
				forbidden: 56,
				ws: false,
			},
			() => systemSnapshot(boss.accessToken),
			async () => {
				expect(codeOf(await rpc(boss.accessToken, "bot.list", {}))).toBe(
					"forbidden",
				);
				expect(
					codeOf(await rpc(boss.accessToken, "system.accounts.list", {})),
				).toBe("ok");
			},
		);
	}, 180_000);
});
