import { describe, expect, it } from "vitest";
import {
	API_ROUTES,
	ApiErrorEnvelopeSchema,
	assertMatchesSchema,
	type CommandType,
	commandCatalog,
	connectTestWs,
	ERROR_CODES,
	encodePayloadQuery,
	ServerToClientSchema,
	SseEventSchema,
	TEST_TOKEN,
	uniqueAccountId,
	useWorkerFixture,
	workerFetch,
} from "./helpers.js";

const MAY_FAIL_OFFLINE = new Set<CommandType>([
	"account.credentials.oauth.start",
	"account.credentials.oauth.status",
	"account.credentials.oauth.submit",
	"account.credentials.oauth.cancel",
	// Need a signed-in session; the master secret has none, so they answer forbidden.
	"auth.ticket",
	"auth.sessions.list",
	"auth.sessions.revoke",
	"auth.sessions.revokeOthers",
	"auth.assumeRole",
	"auth.elevate",
	"auth.elevation.end",
	// System console: the master secret maps to account-admin, so these answer forbidden.
	"system.accounts.list",
	"system.accounts.create",
	"system.accounts.suspend",
	"system.accounts.resume",
	"system.accounts.rename",
	"system.audit.list",
	"system.members.list",
	"system.members.invite",
	"system.members.update",
	"system.members.remove",
	"system.users.disable",
	"system.users.enable",
	"system.users.revokeSessions",
	"auth.tokens.list",
	"auth.tokens.create",
	"auth.tokens.revoke",
	"auth.memberships.list",
	"auth.methods.list",
	"auth.methods.delete",
	"auth.login.providers",
	"auth.login.devPassword",
	"auth.login.token",
	"auth.login.google.start",
	"auth.session.refresh",
	"auth.session.logout",
]);

type Payload = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(body: unknown, path: string[]): string {
	let current: unknown = body;
	for (const key of path) {
		if (!isRecord(current)) {
			throw new Error(
				`missing ${path.join(".")} in ${JSON.stringify(body).slice(0, 400)}`,
			);
		}
		current = current[key];
	}
	if (typeof current !== "string" || current.length === 0) {
		throw new Error(`expected string at ${path.join(".")}`);
	}
	return current;
}

async function callContractApi(
	accountId: string,
	familyId: string,
	command: CommandType,
	payload: Payload,
): Promise<unknown> {
	const route = API_ROUTES[command];
	const headers: Record<string, string> = {
		Authorization: `Bearer ${TEST_TOKEN}`,
		"x-account-id": accountId,
		"X-Cadmus-Family-Id": familyId,
	};
	let url = `http://example.com${route.path}`;
	const init: RequestInit = { method: route.method, headers };
	if (route.readOnly) {
		const query = encodePayloadQuery(payload).toString();
		if (query.length > 0) url += `?${query}`;
	} else {
		headers["Content-Type"] = "application/json";
		init.body = JSON.stringify(payload);
	}
	const response = await workerFetch(url, init);
	const body: unknown = await response.json();
	const entry = commandCatalog[command];
	if (
		response.status !== 200 &&
		(command.startsWith("auth.login.") || command.startsWith("auth.session."))
	) {
		if (
			!isRecord(body) ||
			!isRecord(body.error) ||
			typeof body.error.code !== "string"
		) {
			throw new Error(`${command} error envelope was not readable`);
		}
		return body;
	}
	if (response.status === 200) {
		assertMatchesSchema(entry.result, body, `${command} result`);
		return body;
	}
	assertMatchesSchema(ApiErrorEnvelopeSchema, body, `${command} error`);
	if (
		!isRecord(body) ||
		!isRecord(body.error) ||
		typeof body.error.code !== "string"
	) {
		throw new Error(`${command} error envelope was not readable`);
	}
	expect(
		(ERROR_CODES as readonly string[]).includes(body.error.code),
		`${command} returned an unknown error code ${body.error.code}`,
	).toBe(true);
	if (!MAY_FAIL_OFFLINE.has(command)) {
		throw new Error(
			`${command} failed HTTP ${response.status}: ${JSON.stringify(body).slice(0, 500)}`,
		);
	}
	return body;
}

describe("contract conformance", () => {
	useWorkerFixture();

	it("drives every command through /api and checks the contract schema", async () => {
		const suffix = crypto.randomUUID();
		const accountId = uniqueAccountId("contract");
		const familyId = `fam-${suffix}`;
		const extraFamilyId = `extra-${suffix}`;
		const covered = new Set<string>();

		const call = async (command: CommandType, payload: Payload = {}) => {
			covered.add(command);
			return callContractApi(accountId, familyId, command, payload);
		};

		const createdFamily = await call("family.create", {
			familyId,
			name: "Conformance",
			timezone: "UTC",
		});
		expect(requireString(createdFamily, ["family", "familyId"])).toBe(familyId);

		await call("account.get");
		await call("account.update", {
			name: "Conformance Account",
			timezone: "UTC",
		});
		await call("account.members.list");
		await call("account.members.add", {
			userId: `member-${suffix}`,
			roles: ["user"],
		});
		await call("account.members.invite", {
			email: `invitee-${suffix}@example.com`,
		});
		await call("account.invites.list");
		await call("account.audit.list", { limit: 5 });
		await call("account.invites.revoke", { inviteId: "inv_missing" });
		await call("account.members.update", {
			userId: `member-${suffix}`,
			op: "grant",
			role: "account-admin",
		});
		await call("account.members.remove", { userId: `member-${suffix}` });
		await call("account.credentials.list");
		await call("account.credentials.set", {
			providerId: "faux",
			credential: { type: "api_key", apiKey: "conformance-key" },
		});
		await call("account.credentials.delete", { providerId: "faux" });
		await call("account.models.list", {
			provider: "faux",
			onlyAuthenticated: true,
		});
		await call("account.credentials.oauth.providers");
		await call("account.toolsEnvs.list");
		const createdEnv = await call("account.toolsEnvs.create", {
			kind: "just-bash",
			label: "Conformance",
			persist: false,
		});
		const envId = requireString(createdEnv, ["env", "envId"]);
		await call("account.toolsEnvs.update", {
			envId,
			label: "Conformance renamed",
		});
		const daemonEnv = await call("account.toolsEnvs.create", {
			kind: "local-daemon",
			label: "Conformance Daemon",
			confineToWorkspace: false,
		});
		const daemonEnvId = requireString(daemonEnv, ["env", "envId"]);
		await call("account.toolsEnvs.pair", { envId: daemonEnvId });
		await call("account.toolsEnvs.deregister", { envId: daemonEnvId });
		const deletable = await call("account.toolsEnvs.create", {
			kind: "just-bash",
			label: "Conformance delete",
			persist: false,
		});
		await call("account.toolsEnvs.delete", {
			envId: requireString(deletable, ["env", "envId"]),
		});

		await call("auth.whoami");
		// Session-bound commands: the master secret has no session, so these
		// answer forbidden. Session-backed behavior is covered in
		// packages/worker/tests/sessions.test.ts.
		await call("auth.ticket", { target: "ws" });
		await call("auth.sessions.list");
		await call("auth.sessions.revoke", { sessionId: "ses_missing" });
		await call("auth.sessions.revokeOthers");
		await call("auth.assumeRole", {
			role: "user",
			accountId: "acc_missing",
		});
		await call("auth.elevate");
		await call("auth.elevation.end");
		await call("system.accounts.list");
		await call("system.accounts.create", {
			name: "Conformance",
			ownerEmail: `owner-${suffix}@example.com`,
		});
		await call("system.accounts.suspend", { accountId: "acc_missing" });
		await call("system.accounts.resume", { accountId: "acc_missing" });
		await call("system.accounts.rename", {
			accountId: "acc_missing",
			name: "x",
		});
		await call("system.audit.list");
		await call("system.members.list", { accountId: "acc_missing" });
		await call("system.members.invite", {
			accountId: "acc_missing",
			email: "x@example.com",
		});
		await call("system.members.update", {
			accountId: "acc_missing",
			userId: "usr_missing",
			op: "grant",
			role: "user",
		});
		await call("system.members.remove", {
			accountId: "acc_missing",
			userId: "usr_missing",
		});
		await call("system.users.disable", { userId: "usr_missing" });
		await call("system.users.enable", { userId: "usr_missing" });
		await call("system.users.revokeSessions", { userId: "usr_missing" });
		await call("auth.tokens.list");
		await call("auth.tokens.create", {
			kind: "pat",
			label: "conformance",
			grants: ["chat.use"],
			ttlDays: 1,
		});
		await call("auth.tokens.revoke", { tokenId: "tok_missing" });
		await call("auth.memberships.list");
		await call("auth.methods.list");
		await call("auth.methods.delete", { methodId: "lm_missing" });
		await call("auth.login.providers");
		await call("auth.login.devPassword", { password: "nope" });
		await call("auth.login.token", {});
		await call("auth.login.google.start");
		await call("auth.session.refresh");
		await call("auth.session.logout");
		await call("family.list");
		await call("family.get", { familyId });
		await call("family.update", {
			name: "Conformance renamed",
			harvestDelayMs: 60000,
		});
		const extra = await call("family.create", {
			familyId: extraFamilyId,
			name: "Throwaway",
		});
		expect(requireString(extra, ["family", "familyId"])).toBe(extraFamilyId);
		await call("family.delete", { familyId: extraFamilyId });

		await call("bot.list");
		await call("bot.create", {
			slug: "scribe",
			name: "Scribe",
			model: "faux/echo",
		});
		await call("bot.get", { botId: "scribe" });
		await call("bot.update", { botId: "scribe", name: "Scribe Updated" });

		await call("chat.list", { botId: "scribe" });
		await call("chat.create", { botId: "scribe", key: "main", title: "Main" });
		await call("chat.get", { chatKey: "main" });
		await call("chat.messages", { chatKey: "main" });
		await call("chat.entries", { chatKey: "main" });
		await call("chat.status", { chatKey: "main" });
		await call("turn.submit", {
			chatKey: "main",
			text: '[tool:task_add {"title":"Contract","details":"seed"}]',
		});
		await call("chat.tasks.list", { chatKey: "main" });
		await call("chat.tasks.get", { chatKey: "main", index: 1 });
		await call("chat.subscribe", { chatKey: "main" });
		await call("chat.rename", { chatKey: "main", title: "Renamed" });
		await call("chat.update", {
			chatKey: "main",
			toolsEnv: { enabled: false },
		});

		await call("turn.submit", { chatKey: "main", text: "Hello" });
		await call("turn.steer", { chatKey: "main", text: "Continue" });
		await call("turn.interrupt", { chatKey: "main" });
		await call("turn.abort", { chatKey: "main" });

		await call("file.list", { botId: "scribe", category: "notes" });
		await call("file.write", {
			botId: "scribe",
			path: "knowledge/note.md",
			description: "A note",
			category: "notes",
			body: "Contract note",
		});
		await call("file.read", { botId: "scribe", path: "knowledge/note.md" });
		await call("knowledge.search", {
			botId: "scribe",
			query: "Contract",
			category: "notes",
		});
		await call("file.delete", { botId: "scribe", path: "knowledge/note.md" });

		const schedule = await call("schedule.create", {
			id: "sched-1",
			botId: "scribe",
			name: "Later",
			kind: "absolute",
			input: Date.now() + 86_400_000,
			text: "Ping",
			target: { mode: "chat", chatKey: "main" },
		});
		expect(requireString(schedule, ["schedule", "id"])).toBe("sched-1");
		await call("schedule.list", { botId: "scribe", includeInternal: false });
		await call("schedule.update", { id: "sched-1", enabled: false });
		await call("schedule.delete", { id: "sched-1" });

		await call("chat.reset", { chatKey: "main", handoff: "reset" });
		await call("chat.close", { chatKey: "main" });
		await call("chat.delete", { chatKey: "main" });
		await call("bot.delete", { botId: "scribe" });
		await call("account.toolsEnvs.delete", { envId });

		await call("account.credentials.oauth.start", {
			providerId: "not-a-provider",
		});
		await call("account.credentials.oauth.status", { flowId: "missing-flow" });
		await call("account.credentials.oauth.submit", {
			flowId: "missing-flow",
			input: "code",
		});
		await call("account.credentials.oauth.cancel", { flowId: "missing-flow" });

		expect([...covered].sort()).toEqual(Object.keys(commandCatalog).sort());
		for (const command of Object.keys(API_ROUTES) as CommandType[]) {
			if (API_ROUTES[command].readOnly)
				expect(covered.has(command), command).toBe(true);
		}
	});

	it("validates a WebSocket command result and an invalid frame", async () => {
		const suffix = crypto.randomUUID();
		const accountId = uniqueAccountId("ws-contract");
		const familyId = `fam-ws-${suffix}`;
		await callContractApi(accountId, familyId, "family.create", {
			familyId,
			name: "WS",
		});
		const client = await connectTestWs({ accountId, familyId });
		try {
			const frame = await client.send("account.get", {});
			assertMatchesSchema(ServerToClientSchema, frame, "ws command.result");
			expect(frame.ok).toBe(true);
			if (frame.ok) {
				assertMatchesSchema(
					commandCatalog["account.get"].result,
					frame.result,
					"ws account.get",
				);
			}
			client.ws.send("not-json");
			const start = Date.now();
			while (client.events.length === 0 && Date.now() - start < 5000) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			expect(client.events.length).toBeGreaterThan(0);
			const event = client.events[0];
			assertMatchesSchema(ServerToClientSchema, event, "ws protocol.error");
			expect(event?.type).toBe("protocol.error");
			if (event?.type === "protocol.error") {
				expect(
					(ERROR_CODES as readonly string[]).includes(event.payload.code),
				).toBe(true);
			}
		} finally {
			client.close();
		}
	});

	it("validates an SSE data frame as a server event", async () => {
		const suffix = crypto.randomUUID();
		const accountId = uniqueAccountId("sse-contract");
		const familyId = `fam-sse-${suffix}`;
		await callContractApi(accountId, familyId, "family.create", {
			familyId,
			name: "SSE",
		});
		await callContractApi(accountId, familyId, "bot.create", {
			slug: "echo",
			name: "Echo",
			model: "faux/echo",
		});
		await callContractApi(accountId, familyId, "chat.create", {
			botId: "echo",
			key: "live",
		});

		const response = await workerFetch("http://example.com/events", {
			headers: {
				Authorization: `Bearer ${TEST_TOKEN}`,
				"x-account-id": accountId,
				"X-Cadmus-Family-Id": familyId,
			},
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const reader = response.body?.getReader();
		if (!reader) throw new Error("SSE response has no body");
		const decoder = new TextDecoder();
		let buffer = "";
		const readData = (async () => {
			const started = Date.now();
			while (Date.now() - started < 20000) {
				const chunk = await reader.read();
				if (chunk.done) break;
				buffer += decoder.decode(chunk.value, { stream: true });
				const match = buffer.match(/^data: (.*)$/m);
				if (match?.[1]) return JSON.parse(match[1]) as unknown;
			}
			throw new Error(`SSE produced no data frame: ${buffer.slice(0, 200)}`);
		})();

		await callContractApi(accountId, familyId, "turn.submit", {
			chatKey: "live",
			text: "Hello",
		});
		try {
			const event = await readData;
			assertMatchesSchema(SseEventSchema, event, "sse data");
			expect(isRecord(event) && event.type).not.toBe("command.result");
		} finally {
			await reader.cancel().catch(() => undefined);
		}
	});
});
