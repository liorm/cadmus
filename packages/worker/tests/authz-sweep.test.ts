import { env, SELF } from "cloudflare:test";
import { GRANTS, type Grant, ROLE_GRANTS } from "@cadmus/contract/grants";
import { describe, expect, it } from "vitest";
import { getEdgeCache } from "../src/edge-cache.js";
import {
	commandCatalog,
	getCommandGrant,
	listCommandTypes,
} from "../src/protocol.js";
import { D1AdminStore } from "../src/store/d1-admin.js";
import { rpc, uniqueAccountId } from "./helpers.js";

/**
 * Issue #3 L237, denial sweep over /rpc and /ws. For a plain user and an
 * unelevated account-admin, every registered command the caller must NOT be
 * allowed to run is sent with an empty payload; the exact refusal code is
 * asserted, and the tenant state read before the sweep (members, invites,
 * bots, account, audit count) is unchanged after it.
 * The expected code is derived from the registry grant, ROLE_GRANTS and the
 * grant table's elevation flag. The independent literals live in
 * unit/authz-registry-matrix.test.ts; this file proves each denial is enforced
 * through the real transports. Allowed commands are not called (they have
 * effects); /api is not covered here.
 */
const ORIGIN = "https://example.com";
type Frame = {
	ok: boolean;
	result?: Record<string, unknown>;
	error?: { code?: string };
};

function store(): D1AdminStore {
	return new D1AdminStore({
		db: env.CADMUS_ADMIN_DB,
		encryptionKey: env.CADMUS_ENCRYPTION_KEY,
		edgeCache: getEdgeCache(env),
	});
}

type JsonSchema = {
	const?: unknown;
	enum?: unknown[];
	anyOf?: JsonSchema[];
	oneOf?: JsonSchema[];
	type?: string;
	format?: string;
	minLength?: number;
	minimum?: number;
	minItems?: number;
	items?: JsonSchema;
	properties?: Record<string, JsonSchema>;
	required?: string[];
};
/** Smallest value that satisfies the schema, so a payload never fails validation before authorize(). */
function minimal(sc: JsonSchema | undefined): unknown {
	if (!sc) return {};
	if (sc.const !== undefined) return sc.const;
	if (sc.enum) return sc.enum[0];
	if (sc.anyOf) return minimal(sc.anyOf[0]);
	if (sc.oneOf) return minimal(sc.oneOf[0]);
	switch (sc.type) {
		case "string":
			if (sc.format === "email") return "sweep@example.com";
			return "x".repeat(Math.max(1, sc.minLength ?? 1));
		case "number":
		case "integer":
			return sc.minimum ?? 1;
		case "boolean":
			return false;
		case "array":
			return Array.from({ length: sc.minItems ?? 0 }, () => minimal(sc.items));
		default: {
			const out: Record<string, unknown> = {};
			for (const k of sc.required ?? []) out[k] = minimal(sc.properties?.[k]);
			return out;
		}
	}
}
function payloadFor(type: string): Record<string, unknown> {
	const cmd = (commandCatalog as Record<string, { command: JsonSchema }>)[type]
		?.command;
	const payload = (minimal(cmd?.properties?.payload) ?? {}) as Record<
		string,
		unknown
	>;
	// index.ts resolves the target family before the family DO authorizes (an unknown
	// family answers family_not_found first), so point at the account's real default one.
	if ("familyId" in payload) payload.familyId = "default";
	return payload;
}

type Caller = {
	name: string;
	token: string;
	held: Set<string>;
	elevated: boolean;
};

function expectedDenial(c: Caller, grant: Grant | undefined): string | null {
	// Public login and session routes have no grant. The edge handles them.
	if (!grant) return null;
	if (!c.held.has(grant)) return "forbidden";
	if (GRANTS[grant].elevation && !c.elevated) return "elevation_required";
	return null;
}

/** Tenant state readable by `reader`, as a stable JSON string. */
async function snapshot(
	reader: string,
	readerSession: string,
): Promise<string> {
	const reads = [
		"account.members.list",
		"account.invites.list",
		"bot.list",
		"account.get",
		"account.audit.list",
	];
	const out: Record<string, unknown> = {};
	for (const t of reads) {
		const f = await rpc(reader, t, {});
		out[t] = f.ok ? f.result : `refused:${f.error?.code}`;
	}
	// The reader runs elevated commands, which write their own elevated.command
	// audit rows against the reader's session. Those rows are the snapshot's own
	// effect; every other audit row (including any other session's) must not change.
	const audit = out["account.audit.list"] as
		| { events?: { action: string; target: string }[] }
		| string;
	if (typeof audit !== "string" && audit.events) {
		audit.events = audit.events.filter(
			(e) =>
				!(
					e.target === readerSession && e.action.startsWith("elevated.command")
				),
		);
	}
	return JSON.stringify(out);
}

const WS_REPLY_MS = 2_000;

async function openWs(token: string, who: string) {
	const t = await rpc(token, "auth.ticket", { target: "ws" });
	const res = await SELF.fetch(`${ORIGIN}/ws?ticket=${t.result?.ticket}`, {
		headers: { upgrade: "websocket" },
	});
	const ws = res.webSocket;
	if (!ws) throw new Error(`expected 101, got ${res.status}`);
	ws.accept();
	const pending = new Map<string, (f: Frame) => void>();
	ws.addEventListener("message", (ev) => {
		const f = JSON.parse(ev.data as string) as Frame & { id?: string };
		if (f.id) pending.get(f.id)?.(f);
	});
	return {
		ws,
		// Each call is bounded so a lost reply names the caller and command
		// instead of surfacing as the whole test's generic timeout.
		call: (type: string, payload: Record<string, unknown> = {}) =>
			new Promise<Frame>((resolve, reject) => {
				const id = crypto.randomUUID();
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(
						new Error(
							`/ws reply not received within ${WS_REPLY_MS}ms: caller ${who}, command ${type}`,
						),
					);
				}, WS_REPLY_MS);
				pending.set(id, (f) => {
					clearTimeout(timer);
					pending.delete(id);
					resolve(f);
				});
				ws.send(JSON.stringify({ id, type, payload }));
			}),
	};
}

describe("denial sweep over every registered command (issue #3 L237)", () => {
	it("registry is non-empty and every command grant is in the grant table", () => {
		const types = listCommandTypes();
		expect(types.length).toBe(90);
		for (const t of types) {
			const grant = getCommandGrant(t);
			if (t.startsWith("auth.login.") || t.startsWith("auth.session.")) {
				expect(grant).toBeUndefined();
				continue;
			}
			expect(GRANTS[grant as Grant]).toBeDefined();
		}
	});

	async function setup() {
		const s = store();
		const accountId = uniqueAccountId("swp");
		const adminId = `usr_a_${accountId}`;
		const userId = `usr_u_${accountId}`;
		await s.ensureAccountAndUser({
			accountId,
			userId: adminId,
			role: "account-admin",
		});
		await s.ensureAccountAndUser({ accountId, userId, role: "user" });
		const admin = await s.createSession({ userId: adminId, accountId });
		const user = await s.createSession({ userId, accountId });
		// Admin-mode session reads tenant state around the sweep.
		const owner = await s.createSession({ userId: adminId, accountId });
		expect((await rpc(owner.accessToken, "auth.elevate")).ok).toBe(true);
		const callers: Caller[] = [
			{
				name: "user",
				token: user.accessToken,
				held: new Set(ROLE_GRANTS.user),
				elevated: false,
			},
			{
				name: "account-admin (no admin mode)",
				token: admin.accessToken,
				held: new Set(ROLE_GRANTS["account-admin"]),
				elevated: false,
			},
		];
		return {
			callers,
			readerToken: owner.accessToken,
			readerSession: owner.sessionId,
		};
	}

	const expectedReport = [
		"user: 31 denied of 90",
		"account-admin (no admin mode): 28 denied of 90",
	];
	// Independent literals: calls actually sent per transport, not derived
	// from the denied list the loop iterates. Public login and session
	// commands have no grant, so the sweep does not call them.
	const expectedCalls = [
		{ rpc: 31, ws: 31 },
		{ rpc: 28, ws: 28 },
	];

	for (const [idx, label] of [
		[0, "user"],
		[1, "account-admin (no admin mode)"],
	] as const) {
		it(`every denied (${label}, command) pair is refused with its exact code over /rpc and /ws, and tenant state is unchanged`, async () => {
			const { callers, readerToken, readerSession } = await setup();
			const c = callers[idx] as Caller;
			expect(c.name).toBe(label);
			const before = await snapshot(readerToken, readerSession);
			const denied: [string, string][] = [];
			for (const type of listCommandTypes()) {
				const code = expectedDenial(c, getCommandGrant(type) as Grant);
				if (code) denied.push([type, code]);
			}
			// Independent literal (the sweep size must not move silently).
			expect(
				`${c.name}: ${denied.length} denied of ${listCommandTypes().length}`,
			).toBe(expectedReport[idx]);
			let rpcCalls = 0;
			let wsCalls = 0;
			const wrongRpc: string[] = [];
			for (const [type, code] of denied) {
				const f = await rpc(c.token, type, payloadFor(type));
				rpcCalls += 1;
				const got = f.ok ? "ok" : (f.error?.code ?? "error");
				if (got !== code)
					wrongRpc.push(`${type}: expected ${code}, got ${got}`);
			}
			expect(wrongRpc, `${c.name} /rpc`).toEqual([]);
			// auth.ticket needs chat.use: only callers holding it can open /ws.
			if (c.held.has("chat.use")) {
				const { ws, call } = await openWs(c.token, c.name);
				const wrongWs: string[] = [];
				try {
					for (const [type, code] of denied) {
						const f = await call(type, payloadFor(type));
						wsCalls += 1;
						const got = f.ok ? "ok" : (f.error?.code ?? "error");
						if (got !== code)
							wrongWs.push(`${type}: expected ${code}, got ${got}`);
					}
				} finally {
					ws.close();
				}
				expect(wrongWs, `${c.name} /ws`).toEqual([]);
			}
			expect({ rpc: rpcCalls, ws: wsCalls }, `${c.name} calls sent`).toEqual(
				expectedCalls[idx],
			);
			const after = await snapshot(readerToken, readerSession);
			let diff = "";
			if (after !== before) {
				const a = JSON.parse(before) as Record<string, unknown>;
				const b = JSON.parse(after) as Record<string, unknown>;
				const parts: string[] = [];
				for (const k of Object.keys(a)) {
					if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
						parts.push(
							`${k} BEFORE ${JSON.stringify(a[k]).slice(0, 600)} AFTER ${JSON.stringify(b[k]).slice(0, 600)}`,
						);
					}
				}
				diff = parts.join("\n");
			}
			expect(after, diff).toBe(before);
		});
	}
});
