import { describe, expect, it } from "bun:test";
import {
	assignPath,
	mergePayload,
	parseArgv,
	parseFlagValue,
} from "../src/argv.js";
import {
	EXIT_OK,
	EXIT_PROTOCOL,
	EXIT_TRANSPORT,
	EXIT_TURN,
	EXIT_USAGE,
	exitForCommandFailure,
} from "../src/exit-codes.js";

describe("mergePayload", () => {
	it("applies positional JSON, then --payload, then flags", () => {
		const merged = mergePayload({
			positional: JSON.stringify({ botId: "a", path: "old", nested: { n: 1 } }),
			payloadText: JSON.stringify({ path: "notes.md", content: "from-file" }),
			flags: [
				["content", "from-flag"],
				["target.mode", "chat"],
				["target.chatKey", "notes"],
				["count", "2"],
				["includeInternal", "false"],
			],
		});
		expect(merged).toEqual({
			botId: "a",
			path: "notes.md",
			nested: { n: 1 },
			content: "from-flag",
			target: { mode: "chat", chatKey: "notes" },
			count: 2,
			includeInternal: false,
		});
	});

	it("keeps plain strings and rejects non-object JSON", () => {
		expect(parseFlagValue("scribe")).toBe("scribe");
		expect(parseFlagValue('{"ok":true}')).toEqual({ ok: true });
		expect(() => mergePayload({ positional: "[]", flags: [] })).toThrow(
			"positional JSON must be a JSON object",
		);
		expect(() => mergePayload({ positional: "{", flags: [] })).toThrow(
			"positional JSON is not valid JSON",
		);
	});

	it("parses flags and leaves payload keys out of the global set", () => {
		const parsed = parseArgv([
			"file.write",
			'{"botId":"scribe"}',
			"--pretty",
			"--payload",
			"-",
			"--url",
			"http://127.0.0.1:9",
			"--token",
			"secret",
			"--account",
			"acct",
			"--family",
			"fam",
			"--path",
			"MEMORY.md",
		]);
		expect(parsed.command).toBe("file.write");
		expect(parsed.positionals).toEqual(['{"botId":"scribe"}']);
		expect(parsed.pretty).toBe(true);
		expect(parsed.payloadSource).toBe("-");
		expect(parsed.url).toBe("http://127.0.0.1:9");
		expect(parsed.token).toBe("secret");
		expect(parsed.account).toBe("acct");
		expect(parsed.family).toBe("fam");
		expect(parsed.payloadFlags).toEqual([["path", "MEMORY.md"]]);
	});

	it("ignores prototype-polluting dotted paths", () => {
		const target: Record<string, unknown> = {};
		assignPath(target, "__proto__.polluted", true);
		assignPath(target, "constructor.prototype.polluted", true);
		expect(target).toEqual({});
		expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
	});
});

describe("exitForCommandFailure", () => {
	it("maps auth to 3 and other protocol errors to 1", () => {
		expect(EXIT_OK).toBe(0);
		expect(EXIT_PROTOCOL).toBe(1);
		expect(EXIT_USAGE).toBe(2);
		expect(EXIT_TRANSPORT).toBe(3);
		expect(EXIT_TURN).toBe(4);
		expect(exitForCommandFailure(401, "unauthorized")).toBe(EXIT_TRANSPORT);
		expect(exitForCommandFailure(200, "header_required")).toBe(EXIT_TRANSPORT);
		expect(exitForCommandFailure(409, "query_token_not_allowed")).toBe(
			EXIT_TRANSPORT,
		);
		expect(exitForCommandFailure(404, "not_found")).toBe(EXIT_PROTOCOL);
		expect(exitForCommandFailure(409, "cas_conflict")).toBe(EXIT_PROTOCOL);
		expect(exitForCommandFailure(undefined, "forbidden")).toBe(EXIT_PROTOCOL);
	});
});
