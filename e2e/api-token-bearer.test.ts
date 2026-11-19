import { describe, expect, it } from "vitest";
import {
	adminScope,
	callApi,
	connectTestWs,
	elevateAccessToken,
	provisionInvitedMember,
	sendRpc,
	uniqueAccountId,
	useWorkerFixture,
	WORKER_BASE_URL,
	workerFetch,
} from "./helpers.js";

/**
 * `cad_pat_` and `cad_svc_` are accepted as `Authorization: Bearer` on `/api`
 * and `/rpc` (the CLI sends `CADMUS_TOKEN` that way). Streams still need a
 * ticket. A service token writes `token.use` for every command. Revocation
 * drops the edge cache in this isolate, so the next call fails immediately.
 */
describe("API token bearer", () => {
	useWorkerFixture();

	it("authenticates cad_pat_ and cad_svc_ bearers, audits service uses, and revokes immediately", async () => {
		const { accountId, token, userId } = await adminScope();
		const minted = await sendRpc<{
			token: string;
			summary: { id: string; kind: string };
		}>(
			"auth.tokens.create",
			{
				kind: "service",
				label: "cli",
				grants: ["bot.read", "chat.use", "tokens.self"],
				ttlDays: 7,
			},
			{ accountId, token },
		);
		expect(minted.frame.ok, JSON.stringify(minted.frame)).toBe(true);
		const service = minted.frame.result?.token ?? "";
		const serviceId = minted.frame.result?.summary.id ?? "";
		expect(service.startsWith("cad_svc_")).toBe(true);

		const patMint = await sendRpc<{
			token: string;
			summary: { id: string };
		}>(
			"auth.tokens.create",
			{
				kind: "pat",
				label: "personal",
				grants: ["bot.read", "tokens.self"],
				ttlDays: 7,
			},
			{ accountId, token },
		);
		expect(patMint.frame.ok, JSON.stringify(patMint.frame)).toBe(true);
		const pat = patMint.frame.result?.token ?? "";
		const patId = patMint.frame.result?.summary.id ?? "";
		expect(pat.startsWith("cad_pat_")).toBe(true);

		const owner = userId;
		const who = await callApi<{
			principal: { userId?: string; viaToken?: boolean; role?: string };
		}>(
			"auth.whoami",
			{},
			{ token: service, accountId, userId: "spoofed-user" },
		);
		expect(who.ok, JSON.stringify(who)).toBe(true);
		expect(who.result?.principal.viaToken).toBe(true);
		expect(who.result?.principal.userId).toBe(owner);
		expect(who.result?.principal.role).toBe("account-admin");

		const listed = await callApi<{ bots: unknown[] }>(
			"bot.list",
			{},
			{ token: service, accountId },
		);
		expect(listed.ok, JSON.stringify(listed)).toBe(true);
		expect(listed.result?.bots).toEqual([]);
		// A second call still resolves (cache hit or a fresh read).
		const again = await sendRpc<{ bots: unknown[] }>(
			"bot.list",
			{},
			{ token: service, accountId },
		);
		expect(again.frame.ok).toBe(true);

		const denied = await callApi(
			"family.create",
			{ familyId: "not-allowed", name: "Not allowed" },
			{ token: service, accountId },
		);
		expect(denied.ok).toBe(false);
		expect(denied.error?.code).toBe("forbidden");
		const families = await callApi<{ families: Array<{ familyId: string }> }>(
			"family.list",
			{},
			{ accountId, token },
		);
		expect(families.ok).toBe(true);
		expect(
			families.result?.families.some(
				(family) => family.familyId === "not-allowed",
			),
		).toBe(false);

		const wrongAccount = await callApi(
			"bot.list",
			{},
			{ token: service, accountId: uniqueAccountId("other") },
		);
		expect(wrongAccount.ok).toBe(false);
		expect(wrongAccount.error?.code).toBe("unauthorized");

		const query = await workerFetch(
			`${WORKER_BASE_URL}/api/bot/list?token=${encodeURIComponent(service)}`,
			{ headers: { authorization: `Bearer ${service}` } },
		);
		expect(query.status).toBe(401);
		const stream = await workerFetch(`${WORKER_BASE_URL}/ws`, {
			headers: { authorization: `Bearer ${service}`, upgrade: "websocket" },
		});
		expect(stream.status).toBe(401);

		const patList = await callApi<{ bots: unknown[] }>(
			"bot.list",
			{},
			{ token: pat, accountId },
		);
		expect(patList.ok).toBe(true);

		const audit = await callApi<{
			events: Array<{
				action: string;
				actorKind: string;
				target?: string;
				data?: { use?: string };
			}>;
		}>("account.audit.list", { limit: 100 }, { accountId, token });
		expect(audit.ok, JSON.stringify(audit)).toBe(true);
		const serviceUses = (audit.result?.events ?? []).filter(
			(event) => event.action === "token.use" && event.target === serviceId,
		);
		expect(serviceUses.length).toBeGreaterThan(0);
		expect(serviceUses.every((event) => event.actorKind === "token")).toBe(
			true,
		);
		expect(serviceUses.some((event) => event.data?.use === "bot.list")).toBe(
			true,
		);
		const patUses = (audit.result?.events ?? []).filter(
			(event) => event.action === "token.use" && event.target === patId,
		);
		expect(patUses).toEqual([]);

		const tokens = await callApi<{
			tokens: Array<{ id: string; lastUsedAt: number | null }>;
		}>("auth.tokens.list", {}, { accountId, token });
		expect(tokens.ok).toBe(true);
		expect(
			tokens.result?.tokens.find((token) => token.id === patId)?.lastUsedAt,
		).toEqual(expect.any(Number));

		const socket = await connectTestWs({ token: service, accountId });
		socket.close();

		const revoked = await sendRpc<{ revoked: boolean }>(
			"auth.tokens.revoke",
			{ tokenId: serviceId },
			{ accountId, token },
		);
		expect(revoked.frame.ok).toBe(true);
		expect(revoked.frame.result?.revoked).toBe(true);
		const after = await callApi("bot.list", {}, { token: service, accountId });
		expect(after.ok).toBe(false);
		expect(after.error?.code).toBe("unauthorized");
		const bogus = await callApi(
			"bot.list",
			{},
			{ token: "cad_svc_not-a-real-token", accountId },
		);
		expect(bogus.ok).toBe(false);
		expect(bogus.error?.code).toBe("unauthorized");
	});

	it("audits family.create for a service bearer and refuses it once the token is revoked", async () => {
		const member = await provisionInvitedMember({ role: "account-admin" });
		await elevateAccessToken(member.accessToken);
		const minted = await sendRpc<{
			token: string;
			summary: { id: string };
		}>(
			"auth.tokens.create",
			{
				kind: "service",
				label: "family",
				grants: ["family.manage", "bot.read"],
				ttlDays: 7,
			},
			{ token: member.accessToken },
		);
		expect(minted.frame.ok, JSON.stringify(minted.frame)).toBe(true);
		const service = minted.frame.result?.token ?? "";
		const serviceId = minted.frame.result?.summary.id ?? "";
		expect(service.startsWith("cad_svc_")).toBe(true);

		const familyId = `fam-${crypto.randomUUID().slice(0, 8)}`;
		const created = await callApi<{ family: { familyId: string } }>(
			"family.create",
			{ familyId, name: "Created" },
			{ token: service, accountId: member.accountId },
		);
		expect(created.ok, JSON.stringify(created)).toBe(true);
		expect(created.result?.family.familyId).toBe(familyId);

		const audit = await callApi<{
			events: Array<{
				action: string;
				actorKind: string;
				target?: string;
				data?: { use?: string };
			}>;
		}>("account.audit.list", { limit: 100 }, { token: member.accessToken });
		expect(audit.ok, JSON.stringify(audit)).toBe(true);
		const uses = (audit.result?.events ?? []).filter(
			(event) => event.action === "token.use" && event.target === serviceId,
		);
		expect(uses.some((event) => event.data?.use === "family.create")).toBe(
			true,
		);
		expect(uses.every((event) => event.actorKind === "token")).toBe(true);

		const tokens = await callApi<{
			tokens: Array<{ id: string; lastUsedAt: number | null }>;
		}>("auth.tokens.list", {}, { token: member.accessToken });
		expect(tokens.ok, JSON.stringify(tokens)).toBe(true);
		expect(
			tokens.result?.tokens.find((token) => token.id === serviceId)?.lastUsedAt,
		).toEqual(expect.any(Number));

		const revoked = await sendRpc<{ revoked: boolean }>(
			"auth.tokens.revoke",
			{ tokenId: serviceId },
			{ token: member.accessToken },
		);
		expect(revoked.frame.ok, JSON.stringify(revoked.frame)).toBe(true);
		const againId = `${familyId}-again`;
		const again = await callApi(
			"family.create",
			{ familyId: againId, name: "Again" },
			{ token: service, accountId: member.accountId },
		);
		expect(again.ok).toBe(false);
		expect(again.error?.code).toBe("unauthorized");
		const families = await callApi<{ families: Array<{ familyId: string }> }>(
			"family.list",
			{},
			{ token: member.accessToken },
		);
		expect(families.ok, JSON.stringify(families)).toBe(true);
		expect(
			families.result?.families.some((family) => family.familyId === againId),
		).toBe(false);
		expect(
			families.result?.families.some((family) => family.familyId === familyId),
		).toBe(true);
	});
});
