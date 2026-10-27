import { env } from "cloudflare:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { FileError } from "@earendil-works/pi-durable/env";
import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";
import { createProxyExecutionEnv } from "../packages/worker/src/tools-env/proxy-env.js";
import { NAMESPACE_BYTE_CAP } from "../packages/worker/src/tools-env/pure.js";
import { uniqueAccountId } from "./helpers.js";

const accountId = uniqueAccountId("env-conformance");
const envId = "jb_conf";
const familyId = "conf-family";

function openProxy(scope: string, persist: boolean) {
	const stub = env.CADMUS_ENV.getByName(`env:${accountId}:${envId}`);
	const execution = createProxyExecutionEnv({
		stub,
		id: `just-bash:${accountId}:${envId}:${familyId}:${scope}`,
		call: {
			storageFamilyId: familyId,
			scope,
			botId: "assistant",
			chatKey: "",
			usageFamilyId: familyId,
			persist,
		},
	});
	return { stub, execution };
}

registerEnvConformance(
	{ describe, expect, it },
	"just-bash CadmusEnvDO proxy",
	async (use) => {
		const scope = `bot:case-${crypto.randomUUID()}`;
		const { stub, execution } = openProxy(scope, false);
		try {
			await use(execution);
		} finally {
			await stub.deleteNamespace(familyId, scope);
		}
	},
	{ shell: ["bash", "-c"], symlinks: true, listFiles: false },
);

describe("just-bash namespace cap and persistence", () => {
	it("keeps a persisted file after the in-memory namespace is dropped", async () => {
		const scope = "bot:persist-case";
		const { stub, execution } = openProxy(scope, true);
		const written = await execution.writeFile(
			"kept.txt",
			"still-here",
			BACKGROUND_CONTEXT,
		);
		expect(written.ok).toBe(true);
		await stub.dropCachedNamespaces();
		const read = await execution.readTextFile("kept.txt", BACKGROUND_CONTEXT);
		expect(read.ok).toBe(true);
		if (read.ok) expect(read.value).toBe("still-here");
		await stub.deleteNamespace(familyId, scope);
	});

	it("rejects writes past 8 MiB and counts a replacement once", async () => {
		const scope = "bot:cap-sqlite";
		const { stub, execution } = openProxy(scope, true);
		const six = new Uint8Array(6 * 1024 * 1024);
		six.fill(1);
		expect(
			(await execution.writeFile("blob.bin", six, BACKGROUND_CONTEXT)).ok,
		).toBe(true);
		expect(
			(await execution.writeFile("blob.bin", six, BACKGROUND_CONTEXT)).ok,
		).toBe(true);
		expect(await stub.namespaceBytes(familyId, scope)).toBe(six.byteLength);
		expect(
			(await execution.remove("blob.bin", undefined, BACKGROUND_CONTEXT)).ok,
		).toBe(true);

		const full = new Uint8Array(NAMESPACE_BYTE_CAP);
		full.fill(2);
		expect(
			(await execution.writeFile("full.bin", full, BACKGROUND_CONTEXT)).ok,
		).toBe(true);
		const extra = await execution.writeFile(
			"more.txt",
			"x",
			BACKGROUND_CONTEXT,
		);
		expect(extra.ok).toBe(false);
		if (!extra.ok) {
			expect(extra.error).toBeInstanceOf(FileError);
			expect(extra.error.code).toBe("invalid");
		}
		expect(await stub.namespaceBytes(familyId, scope)).toBeLessThanOrEqual(
			NAMESPACE_BYTE_CAP,
		);
		await stub.deleteNamespace(familyId, scope);
	}, 60_000);

	it("rejects two different-path writes whose sizes each fit but whose sum does not", async () => {
		const scope = "bot:cap-race";
		const { stub, execution } = openProxy(scope, false);
		const five = new Uint8Array(5 * 1024 * 1024);
		five.fill(3);
		const [left, right] = await Promise.all([
			execution.writeFile("left.bin", five, BACKGROUND_CONTEXT),
			execution.writeFile("right.bin", five, BACKGROUND_CONTEXT),
		]);
		const oks = [left.ok, right.ok].filter(Boolean).length;
		expect(oks).toBe(1);
		const failed = left.ok ? right : left;
		expect(failed.ok).toBe(false);
		if (!failed.ok) expect(failed.error.code).toBe("invalid");
		expect(await stub.namespaceBytes(familyId, scope)).toBeLessThanOrEqual(
			NAMESPACE_BYTE_CAP,
		);
		await stub.deleteNamespace(familyId, scope);
	}, 60_000);

	it("treats an empty file as zero lines and EOF on the line reader", async () => {
		const scope = "bot:empty-lines";
		const { stub, execution } = openProxy(scope, false);
		expect(
			(await execution.writeFile("empty.txt", "", BACKGROUND_CONTEXT)).ok,
		).toBe(true);
		const lines = await execution.readTextLines(
			"empty.txt",
			undefined,
			BACKGROUND_CONTEXT,
		);
		expect(lines.ok).toBe(true);
		if (lines.ok) expect(lines.value).toEqual([]);
		const opened = await execution.openTextLineReader(
			"empty.txt",
			BACKGROUND_CONTEXT,
		);
		expect(opened.ok).toBe(true);
		if (opened.ok) {
			const first = await opened.value.readLine(BACKGROUND_CONTEXT);
			expect(first.ok).toBe(true);
			if (first.ok) expect(first.value).toBeUndefined();
			await opened.value.close(BACKGROUND_CONTEXT);
		}
		await stub.deleteNamespace(familyId, scope);
	});

	it("rolls back byte reservation when a write or cp fails", async () => {
		const scope = "bot:reserve-rollback";
		const { stub, execution } = openProxy(scope, false);
		expect(
			(
				await execution.createDir(
					"folder",
					{ recursive: true },
					BACKGROUND_CONTEXT,
				)
			).ok,
		).toBe(true);
		const four = new Uint8Array(4 * 1024 * 1024);
		four.fill(3);
		expect(
			(await execution.writeFile("dest.bin", four, BACKGROUND_CONTEXT)).ok,
		).toBe(true);
		const copied = await execution.exec(
			"cp /workspace/folder /workspace/dest.bin",
			undefined,
			BACKGROUND_CONTEXT,
		);
		expect(copied.ok).toBe(true);
		if (copied.ok) expect(copied.value.exitCode).not.toBe(0);
		const five = new Uint8Array(5 * 1024 * 1024);
		five.fill(4);
		const overflow = await execution.writeFile(
			"more.bin",
			five,
			BACKGROUND_CONTEXT,
		);
		expect(overflow.ok).toBe(false);
		if (!overflow.ok) {
			expect(overflow.error).toBeInstanceOf(FileError);
			expect(overflow.error.code).toBe("invalid");
		}
		expect(
			(await execution.writeFile("ok.bin", "fits", BACKGROUND_CONTEXT)).ok,
		).toBe(true);
		await stub.deleteNamespace(familyId, scope);
	}, 60_000);

	it("counts aliased write paths as one file under the cap", async () => {
		const scope = "bot:alias-lock";
		const { stub, execution } = openProxy(scope, false);
		const five = new Uint8Array(5 * 1024 * 1024);
		five.fill(5);
		expect(
			(await execution.writeFile("alias.bin", five, BACKGROUND_CONTEXT)).ok,
		).toBe(true);
		const [relative, absolute] = await Promise.all([
			execution.writeFile("./alias.bin", five, BACKGROUND_CONTEXT),
			execution.writeFile("/workspace/alias.bin", five, BACKGROUND_CONTEXT),
		]);
		expect(relative.ok).toBe(true);
		expect(absolute.ok).toBe(true);
		expect(await stub.namespaceBytes(familyId, scope)).toBe(five.byteLength);
		await stub.deleteNamespace(familyId, scope);
	}, 60_000);
});
