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
	"account.oauth.start",
	"account.oauth.status",
	"account.oauth.submit",
	"account.oauth.cancel",
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
			role: "member",
		});
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
		await call("account.oauth.providers");
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
		await call("bot.delete", { botId: "scribe" });
		await call("account.toolsEnvs.delete", { envId });

		await call("account.oauth.start", { providerId: "not-a-provider" });
		await call("account.oauth.status", { flowId: "missing-flow" });
		await call("account.oauth.submit", {
			flowId: "missing-flow",
			input: "code",
		});
		await call("account.oauth.cancel", { flowId: "missing-flow" });

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
