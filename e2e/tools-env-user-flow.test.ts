import {
	CODE_EXECUTE_TOOL_NAME,
	CODING_TOOL_NAMES,
} from "@cadmus/contract/tools";
import { describe, expect, it } from "vitest";
import {
	capturesInclude,
	runToolsEnvUserFlow,
	type UserFlowKind,
	type UserFlowPin,
} from "./user-flow.js";

/**
 * Owner flow: tools env, then a bot created with the default tool set
 * (`bot.tools` omitted), then a chat whose env is pinned or inherited,
 * then one bash turn.
 * The daemon cases spawn the real cadmus-daemon process.
 */
async function expectCodingTurn(input: {
	label: string;
	kind: UserFlowKind;
	pin: UserFlowPin;
}): Promise<void> {
	const flow = await runToolsEnvUserFlow(input);
	expect(flow.offeredTools.length).toBeGreaterThan(0);
	for (const name of CODING_TOOL_NAMES) {
		expect(capturesInclude(flow.offeredTools, name)).toBe(true);
	}
	for (const tools of flow.offeredTools) {
		expect(tools).not.toContain(CODE_EXECUTE_TOOL_NAME);
	}
	expect(flow.toolError).toBe(false);
	expect(flow.toolContent).toContain("cadmus-flow-");
	expect(flow.toolContent).not.toContain("printf");
	expect(flow.transcript).toContain("Use bash, read, write, and edit");
}

describe("tools env user flow", () => {
	it("offers daemon bash when the chat pins that env", async () => {
		await expectCodingTurn({
			label: "daemon-chat",
			kind: "local-daemon",
			pin: "chat",
		});
	}, 40_000);

	it("offers daemon bash when the chat inherits the bot env", async () => {
		await expectCodingTurn({
			label: "daemon-bot",
			kind: "local-daemon",
			pin: "bot",
		});
	}, 40_000);

	it("offers daemon bash when the chat inherits the account default", async () => {
		await expectCodingTurn({
			label: "daemon-account",
			kind: "local-daemon",
			pin: "account",
		});
	}, 40_000);

	it("offers just-bash when the chat pins that env", async () => {
		await expectCodingTurn({
			label: "bash-chat",
			kind: "just-bash",
			pin: "chat",
		});
	}, 40_000);

	it("offers just-bash when the chat inherits the bot env", async () => {
		await expectCodingTurn({
			label: "bash-bot",
			kind: "just-bash",
			pin: "bot",
		});
	}, 40_000);

	it("offers just-bash when the chat inherits the account default", async () => {
		await expectCodingTurn({
			label: "bash-account",
			kind: "just-bash",
			pin: "account",
		});
	}, 40_000);
});
