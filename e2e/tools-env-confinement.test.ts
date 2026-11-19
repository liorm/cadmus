import { describe, expect, it } from "vitest";
import {
	adminScope,
	type RpcOptions,
	ScriptedDaemon,
	sendRpc,
	useWorkerFixture,
	workerFetch,
} from "./helpers.js";

async function scope(
	_label: string,
	familyId = "default",
): Promise<RpcOptions & { accountId: string; familyId: string }> {
	return adminScope(familyId);
}

async function registerDaemonWithPolicy(
	options: RpcOptions,
	input: {
		confinementPolicy?: "required" | "preferred" | "disabled";
		confineToWorkspace?: boolean;
	},
): Promise<{ envId: string; token: string }> {
	const created = await sendRpc<{
		env: {
			envId: string;
			confineToWorkspace: boolean;
			confinementPolicy?: string;
		};
		pairingToken?: string;
	}>(
		"account.toolsEnvs.create",
		{
			kind: "local-daemon",
			persist: true,
			...(input.confinementPolicy !== undefined
				? { confinementPolicy: input.confinementPolicy }
				: {}),
			...(input.confineToWorkspace !== undefined
				? { confineToWorkspace: input.confineToWorkspace }
				: {}),
			baseUrl: "http://example.com",
		},
		options,
	);
	expect(created.frame.ok).toBe(true);
	const envId = created.frame.result?.env.envId ?? "";
	const pairingToken = created.frame.result?.pairingToken ?? "";
	const pairResponse = await workerFetch("http://example.com/tools-env/pair", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ pairingToken, name: "ConfinementRig" }),
	});
	expect(pairResponse.status).toBe(200);
	const redeemed = (await pairResponse.json()) as { token: string };
	return { envId, token: redeemed.token };
}

describe("tools-env confinement policy negotiation (E2E Contract)", () => {
	useWorkerFixture();

	it("enforces 'required' policy: rejects unconfined daemons with 409 and rich error body", async () => {
		const options = await scope("req");
		const { envId, token } = await registerDaemonWithPolicy(options, {
			confinementPolicy: "required",
		});

		// 1. Verify policy on listed env
		const listed = await sendRpc<{
			envs: Array<{
				envId: string;
				confineToWorkspace: boolean;
				confinementPolicy?: string;
			}>;
		}>("account.toolsEnvs.list", {}, options);
		expect(listed.frame.ok).toBe(true);
		const env = listed.frame.result?.envs.find((e) => e.envId === envId);
		expect(env?.confinementPolicy).toBe("required");
		expect(env?.confineToWorkspace).toBe(true);

		// 2. Dial without confinement capability -> 409 with descriptive JSON
		const unconfinedDial = await ScriptedDaemon.upgrade({
			token,
			envId,
		});
		expect(unconfinedDial.status).toBe(409);
		const errBody = JSON.parse(unconfinedDial.body) as {
			error: { code: string; message: string };
		};
		expect(errBody.error.code).toBe("confinement_required");
		expect(errBody.error.message).toContain(
			"Environment requires confinement, but daemon connected with confinement disabled",
		);

		// 3. Dial with confinement capability -> 101 accept
		const confinedDial = await ScriptedDaemon.upgrade({
			token,
			envId,
			capabilities: "confinement",
		});
		expect(confinedDial.status).toBe(101);

		// 4. Verify connection status reports confined: true
		const listConnected = await sendRpc<{
			envs: Array<{
				envId: string;
				connection?: {
					status: string;
					confined?: boolean;
				};
			}>;
		}>("account.toolsEnvs.list", {}, options);
		const connectedEnv = listConnected.frame.result?.envs.find(
			(e) => e.envId === envId,
		);
		expect(connectedEnv?.connection?.status).toBe("connected");
		expect(connectedEnv?.connection?.confined).toBe(true);
	});

	it("allows 'preferred' policy: accepts both confined and unconfined daemons and records effective state", async () => {
		const options = await scope("pref");
		const { envId, token } = await registerDaemonWithPolicy(options, {
			confinementPolicy: "preferred",
		});

		// 1. Dial without confinement capability -> ACCEPTED (no 409!)
		const unconfinedDial = await ScriptedDaemon.upgrade({
			token,
			envId,
		});
		expect(unconfinedDial.status).toBe(101);

		// Verify connection reports effective confined: false
		const listUnconfined = await sendRpc<{
			envs: Array<{
				envId: string;
				connection?: {
					status: string;
					confined?: boolean;
				};
			}>;
		}>("account.toolsEnvs.list", {}, options);
		const envUnconfined = listUnconfined.frame.result?.envs.find(
			(e) => e.envId === envId,
		);
		expect(envUnconfined?.connection?.status).toBe("connected");
		expect(envUnconfined?.connection?.confined).toBe(false);

		// 2. Reconnect with confinement capability -> ACCEPTED and reports confined: true
		const confinedDial = await ScriptedDaemon.upgrade({
			token,
			envId,
			capabilities: "confinement",
		});
		expect(confinedDial.status).toBe(101);

		const listConfined = await sendRpc<{
			envs: Array<{
				envId: string;
				connection?: {
					status: string;
					confined?: boolean;
				};
			}>;
		}>("account.toolsEnvs.list", {}, options);
		const envConfined = listConfined.frame.result?.envs.find(
			(e) => e.envId === envId,
		);
		expect(envConfined?.connection?.status).toBe("connected");
		expect(envConfined?.connection?.confined).toBe(true);
	});

	it("handles 'disabled' policy: connects unconfined without requirement", async () => {
		const options = await scope("dis");
		const { envId, token } = await registerDaemonWithPolicy(options, {
			confinementPolicy: "disabled",
		});

		const dial = await ScriptedDaemon.upgrade({
			token,
			envId,
		});
		expect(dial.status).toBe(101);

		const listRes = await sendRpc<{
			envs: Array<{
				envId: string;
				confinementPolicy?: string;
				connection?: {
					status: string;
					confined?: boolean;
				};
			}>;
		}>("account.toolsEnvs.list", {}, options);
		const env = listRes.frame.result?.envs.find((e) => e.envId === envId);
		expect(env?.confinementPolicy).toBe("disabled");
		expect(env?.connection?.status).toBe("connected");
		expect(env?.connection?.confined).toBe(false);
	});

	it("preserves backward compatibility with confineToWorkspace boolean", async () => {
		const options = await scope("compat");

		// confineToWorkspace: true maps to required
		const { envId: envTrue } = await registerDaemonWithPolicy(options, {
			confineToWorkspace: true,
		});
		const listTrue = await sendRpc<{
			envs: Array<{
				envId: string;
				confineToWorkspace: boolean;
				confinementPolicy?: string;
			}>;
		}>("account.toolsEnvs.list", {}, options);
		const itemTrue = listTrue.frame.result?.envs.find(
			(e) => e.envId === envTrue,
		);
		expect(itemTrue?.confineToWorkspace).toBe(true);
		expect(itemTrue?.confinementPolicy).toBe("required");

		// confineToWorkspace: false maps to disabled
		const { envId: envFalse } = await registerDaemonWithPolicy(options, {
			confineToWorkspace: false,
		});
		const listFalse = await sendRpc<{
			envs: Array<{
				envId: string;
				confineToWorkspace: boolean;
				confinementPolicy?: string;
			}>;
		}>("account.toolsEnvs.list", {}, options);
		const itemFalse = listFalse.frame.result?.envs.find(
			(e) => e.envId === envFalse,
		);
		expect(itemFalse?.confineToWorkspace).toBe(false);
		expect(itemFalse?.confinementPolicy).toBe("disabled");

		// Update to preferred
		const updated = await sendRpc<{
			env: {
				envId: string;
				confinementPolicy?: string;
			};
		}>(
			"account.toolsEnvs.update",
			{
				envId: envTrue,
				confinementPolicy: "preferred",
			},
			options,
		);
		expect(updated.frame.ok).toBe(true);
		expect(updated.frame.result?.env.confinementPolicy).toBe("preferred");
	});
});
