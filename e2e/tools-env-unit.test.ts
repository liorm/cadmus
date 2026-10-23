import { describe, expect, it } from "vitest";
import { ProtocolValidationError } from "../src/protocol/common.js";
import {
	assertDaemonEnvWrite,
	assertJustBashEnvWrite,
	assertToolsEnvWrite,
	chooseToolsEnvIdentity,
	daemonLockPaths,
	envDoName,
	executionEnvId,
	resolveHostPath,
	resolveToolsEnv,
	runtimeToolsEnvOn,
	scopeString,
	storageFamilyId,
	supportsConfinement,
	writeOpLockPaths,
} from "../src/tools-env/pure.js";
import {
	isDaemonBearerToken,
	isTransportMessage,
	MAX_FRAME_BYTES,
	parseDaemonFrame,
	parseWireRequest,
	peerErrorMessage,
	TRANSPORT_DISCONNECTED,
	transportFailure,
} from "../src/tools-env/wire.js";

describe("resolveToolsEnv", () => {
	const account = { envId: "jb_default" };
	const botPin = { enabled: true, binding: { envId: "jb_bot" } };
	const chatPin = { enabled: true, binding: { envId: "jb_chat" } };

	it("inherits the account default when chat and bot are unset", () => {
		const resolved = resolveToolsEnv({ chat: null, bot: null, account });
		expect(resolved).toMatchObject({
			enabled: true,
			enabledSource: "account",
			binding: account,
			bindingSource: "account",
			scopeKind: "bot",
		});
		expect(runtimeToolsEnvOn(resolved)).toBe(true);
	});

	it("lets chat enabled and chat binding win independently", () => {
		const resolved = resolveToolsEnv({
			chat: { enabled: false, binding: { envId: "jb_chat" } },
			bot: botPin,
			account,
		});
		expect(resolved.enabled).toBe(false);
		expect(resolved.enabledSource).toBe("chat");
		expect(resolved.binding).toEqual({ envId: "jb_chat" });
		expect(resolved.bindingSource).toBe("chat");
		expect(resolved.scopeKind).toBe("bot");
		expect(runtimeToolsEnvOn(resolved)).toBe(false);
	});

	it("uses the bot namespace when a chat is on without its own binding", () => {
		const resolved = resolveToolsEnv({
			chat: { enabled: true },
			bot: { enabled: false, binding: { envId: "jb_bot" } },
			account,
		});
		expect(resolved.enabled).toBe(true);
		expect(resolved.enabledSource).toBe("chat");
		expect(resolved.bindingSource).toBe("bot");
		expect(resolved.scopeKind).toBe("bot");
	});

	it("retains bot scope even when a chat pins a binding", () => {
		const resolved = resolveToolsEnv({
			chat: chatPin,
			bot: null,
			account,
		});
		expect(resolved.scopeKind).toBe("bot");
		expect(resolved.binding?.envId).toBe("jb_chat");
	});

	it("is unbound when every level is missing", () => {
		const resolved = resolveToolsEnv({});
		expect(resolved.enabled).toBe(false);
		expect(resolved.enabledSource).toBe("unbound");
		expect(resolved.binding).toBeNull();
		expect(runtimeToolsEnvOn(resolved)).toBe(false);
	});
});

describe("tools env ids and writes", () => {
	it("formats scopes and execution env ids without splitting on colon", () => {
		expect(scopeString("chat", "assistant:room")).toBe("chat:assistant:room");
		expect(scopeString("bot", "assistant")).toBe("bot:assistant");
		expect(storageFamilyId(true, "family-a")).toBe("");
		expect(storageFamilyId(false, "family-a")).toBe("family-a");
		expect(envDoName("acct", "jb_default")).toBe("env:acct:jb_default");
		expect(
			executionEnvId({
				kind: "just-bash",
				accountId: "acct",
				envId: "jb_default",
				familyId: "fam",
				scope: "chat:assistant:room",
			}),
		).toBe("just-bash:acct:jb_default:fam:chat:assistant:room");
		expect(
			executionEnvId({
				kind: "just-bash",
				accountId: "acct",
				envId: "jb_default",
				sharedWorkspace: true,
				scope: "bot:assistant",
			}),
		).toBe("just-bash:acct:jb_default:shared:bot:assistant");
		expect(
			executionEnvId({ kind: "daemon", accountId: "acct", envId: "edge" }),
		).toBe("daemon:acct:edge");
	});

	it("normalizes aliased write paths onto one lock key", () => {
		expect(writeOpLockPaths("writeFile", { path: "file.txt" })).toEqual([
			"/workspace/file.txt",
		]);
		expect(
			writeOpLockPaths("writeFile", { path: "/workspace/file.txt" }),
		).toEqual(["/workspace/file.txt"]);
		expect(writeOpLockPaths("writeFile", { path: "./file.txt" })).toEqual([
			"/workspace/file.txt",
		]);
		expect(
			writeOpLockPaths("writeFile", { path: "/workspace/sub/../file.txt" }),
		).toEqual(["/workspace/file.txt"]);
		expect(
			writeOpLockPaths("renameFile", {
				source: "a.txt",
				dest: "/workspace/b.txt",
			}),
		).toEqual(["/workspace/a.txt", "/workspace/b.txt"]);
		expect(writeOpLockPaths("readTextFile", { path: "file.txt" })).toEqual([]);
	});

	it("rejects just-bash confinement off and unknown kinds", () => {
		expect(supportsConfinement("just-bash")).toBe(true);
		expect(supportsConfinement("local-daemon")).toBe(true);
		expect(supportsConfinement("other")).toBe(false);
		expect(() =>
			assertJustBashEnvWrite({ kind: "just-bash", confineToWorkspace: false }),
		).toThrow(ProtocolValidationError);
		try {
			assertJustBashEnvWrite({ kind: "just-bash", confineToWorkspace: false });
		} catch (error) {
			expect((error as ProtocolValidationError).code).toBe(
				"confinement_required",
			);
		}
		expect(() => assertJustBashEnvWrite({ kind: "local-daemon" })).toThrow(
			ProtocolValidationError,
		);
		expect(() =>
			assertJustBashEnvWrite({
				kind: "just-bash",
				confineToWorkspace: true,
			}),
		).not.toThrow();
	});

	it("rejects enabled writes that cannot resolve a binding", () => {
		expect(() =>
			assertToolsEnvWrite({
				setting: { enabled: true },
				level: "bot",
				accountDefault: null,
				lookup: () => undefined,
			}),
		).toThrow(ProtocolValidationError);
		try {
			assertToolsEnvWrite({
				setting: { enabled: true },
				level: "bot",
				accountDefault: null,
				lookup: () => undefined,
			});
		} catch (error) {
			expect((error as ProtocolValidationError).code).toBe(
				"tools_env_on_without_config",
			);
		}
		expect(() =>
			assertToolsEnvWrite({
				setting: { enabled: true },
				level: "bot",
				accountDefault: { envId: "jb_default" },
				lookup: () => ({ kind: "just-bash" }),
			}),
		).not.toThrow();
		expect(() =>
			assertToolsEnvWrite({
				setting: {
					enabled: true,
					binding: { envId: "ld_edge" },
				},
				level: "bot",
				accountDefault: { envId: "jb_default" },
				lookup: (envId) =>
					envId === "ld_edge" ? { kind: "local-daemon" } : undefined,
			}),
		).not.toThrow();
	});

	it("stores daemon confinement and rejects a shared daemon workspace", () => {
		expect(() =>
			assertDaemonEnvWrite({
				secretId: "hs_1",
				workspacePath: "/home/me/src",
				confineToWorkspace: true,
			}),
		).not.toThrow();
		expect(() =>
			assertDaemonEnvWrite({
				secretId: "hs_1",
				workspacePath: "/home/me/src",
				confineToWorkspace: false,
				sharedWorkspace: false,
			}),
		).not.toThrow();
		expect(() =>
			assertDaemonEnvWrite({
				secretId: "hs_1",
				workspacePath: "/home/me/src",
				confineToWorkspace: true,
				sharedWorkspace: true,
			}),
		).toThrow(ProtocolValidationError);
		try {
			assertDaemonEnvWrite({
				secretId: "hs_1",
				workspacePath: "  ",
				confineToWorkspace: true,
			});
		} catch (error) {
			expect((error as ProtocolValidationError).code).toBe("invalid_tools_env");
		}
	});
});

describe("chooseToolsEnvIdentity", () => {
	it("names the coding tools only when the env is connected and offered", () => {
		const ready = chooseToolsEnvIdentity({
			enabled: true,
			connected: true,
			toolsOffered: true,
			harvest: false,
			kind: "just-bash",
			envId: "jb_default",
			enabledSource: "chat",
			bindingSource: "chat",
			persist: true,
			confineToWorkspace: true,
			sharedWorkspace: false,
			scopeKind: "chat",
			botDefaultKind: "local-daemon",
		});
		expect(ready?.name).toBe("tools-env");
		expect(ready?.text).toContain("bash, read, write, and edit");
		expect(ready?.text).toContain("code.execute");
		expect(ready?.text).toContain("The bot default is local-daemon");
		expect(ready?.text).toContain("this chat");

		const down = chooseToolsEnvIdentity({
			enabled: true,
			connected: false,
			toolsOffered: true,
			harvest: false,
			kind: "local-daemon",
			enabledSource: "bot",
		});
		expect(down?.name).toBe("tools-env-unavailable");
		expect(down?.text).not.toContain("bash");
		expect(down?.text).toContain("reconnects on its own");
		expect(down?.text).toContain("Memory, knowledge, and schedules still work");
	});

	it("checks daemon bearer shape, wire frames, and transport classification", () => {
		expect(isDaemonBearerToken(`cadmus_dt_${"a".repeat(64)}`)).toBe(true);
		expect(isDaemonBearerToken(`cadmus_dt_${"A".repeat(64)}`)).toBe(false);
		expect(isDaemonBearerToken("cadmus_dt_short")).toBe(false);
		expect(isDaemonBearerToken(`user_${"a".repeat(64)}`)).toBe(false);

		const request = parseWireRequest(
			JSON.stringify({ id: "1", method: "exec", args: { command: "pwd" } }),
		);
		expect(request).toMatchObject({
			action: "request",
			request: { id: "1", method: "exec" },
		});
		expect(parseWireRequest("x".repeat(MAX_FRAME_BYTES + 1)).action).toBe(
			"too-large",
		);
		expect(parseWireRequest("{").action).toBe("invalid");
		expect(
			parseWireRequest(
				JSON.stringify({ id: "1", type: "bot.delete", payload: {} }),
			).action,
		).toBe("client-command");
		expect(
			parseWireRequest(JSON.stringify({ id: "1", method: "probe" })).action,
		).toBe("invalid");
		expect(parseDaemonFrame("x".repeat(MAX_FRAME_BYTES + 1)).action).toBe(
			"too-large",
		);
		expect(
			parseDaemonFrame(JSON.stringify({ id: "9", type: "chat.delete" })).action,
		).toBe("client-command");

		expect(peerErrorMessage(`${TRANSPORT_DISCONNECTED} copied`)).toBe(
			"env disconnected copied",
		);
		expect(peerErrorMessage("permission denied")).toBe("permission denied");
		expect(isTransportMessage(TRANSPORT_DISCONNECTED)).toBe(true);
		expect(isTransportMessage("env disconnected")).toBe(false);
		expect(transportFailure("exec")).toEqual({
			kind: "exec",
			code: "shell_unavailable",
			message: TRANSPORT_DISCONNECTED,
		});
		expect(transportFailure("readTextFile")).toEqual({
			kind: "file",
			code: "unknown",
			message: TRANSPORT_DISCONNECTED,
		});
	});

	it("forwards host paths and locks daemon writes on the raw path", () => {
		expect(resolveHostPath("../escape", "/home/dev/workspace")).toEqual({
			ok: true,
			path: "/home/dev/escape",
		});
		expect(resolveHostPath("/etc/passwd", "/home/dev/workspace")).toEqual({
			ok: true,
			path: "/etc/passwd",
		});
		expect(daemonLockPaths("writeFile", { path: "/home/a/file" })).toEqual([
			"/home/a/file",
		]);
		expect(
			daemonLockPaths("writeFile", { path: "/home/a/file" })[0],
		).not.toContain("/workspace");
		expect(
			daemonLockPaths("renameFile", {
				source: "/home/a/old",
				dest: "/home/a/new",
			}),
		).toEqual(["/home/a/old", "/home/a/new"]);
		expect(daemonLockPaths("exec", { command: "pwd" })).toEqual([]);
		expect(writeOpLockPaths("exec", { command: "pwd" })).toEqual([]);
	});

	it("omits both sections when off, unoffered, or harvesting", () => {
		expect(
			chooseToolsEnvIdentity({
				enabled: false,
				connected: true,
				toolsOffered: true,
				harvest: false,
			}),
		).toBeUndefined();
		expect(
			chooseToolsEnvIdentity({
				enabled: true,
				connected: true,
				toolsOffered: false,
				harvest: false,
			}),
		).toBeUndefined();
		expect(
			chooseToolsEnvIdentity({
				enabled: true,
				connected: true,
				toolsOffered: true,
				harvest: true,
			}),
		).toBeUndefined();
	});
});
