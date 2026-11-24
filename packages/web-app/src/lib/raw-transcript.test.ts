import { describe, expect, it } from "bun:test";
import type { RawTranscriptEntry } from "@cadmus/contract/types";
import { rawTranscriptLines } from "./raw-transcript";

describe("rawTranscriptLines", () => {
	it("labels user, assistant, tool call JSON, tool results, compaction, and reset entries", () => {
		const entries: RawTranscriptEntry[] = [
			{
				id: 1,
				conversationId: 1,
				kind: "user",
				model: [
					{
						role: "user",
						timestamp: Date.parse("2026-11-02T18:04:11Z"),
						content: [{ type: "text", text: "Shift heating" }],
					},
				],
			},
			{
				id: 2,
				conversationId: 1,
				kind: "assistant",
				model: [
					{
						role: "assistant",
						content: [
							{ type: "text", text: "On it." },
							{
								type: "toolCall",
								name: "read_file",
								arguments: { path: "automations.yaml" },
							},
						],
					},
					{
						role: "toolResult",
						toolName: "read_file",
						content: [{ type: "text", text: "ok" }],
					},
				],
			},
			{
				id: 3,
				conversationId: 1,
				kind: "pi.compaction",
				head: 2,
				data: { reason: "threshold" },
				model: [{ role: "user", content: "Summary text" }],
			},
			{
				id: 4,
				conversationId: 1,
				kind: "pi.reset",
				head: 4,
				model: [{ role: "user", content: "New session" }],
			},
		];
		const lines = rawTranscriptLines(entries);
		expect(lines.map((line) => line.role)).toEqual([
			"user",
			"assistant",
			"tool_call",
			"tool_result",
			"compaction",
			"reset",
		]);
		expect(lines[2]?.name).toBe("read_file");
		expect(lines[2]?.body).toContain('"path": "automations.yaml"');
		expect(lines[3]?.body).toBe("ok");
		expect(lines[4]?.name).toBe("threshold");
		expect(lines[4]?.body).toBe("Summary text");
		expect(lines[5]?.body).toBe("New session");
	});
});
