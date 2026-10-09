// pi-durable's own storage conformance suite, run under Bun against openNodeSqliteStorage (Bun's node:sqlite).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type ExpectLike, registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "bun:test";

registerStorageConformance(
	{ describe, expect: expect as unknown as ExpectLike, it },
	"pi-durable SQLite storage under Bun",
	async (use) => {
		const directory = await mkdtemp(join(tmpdir(), "pi-bot-storage-"));
		const storage = await openNodeSqliteStorage(join(directory, "durable.sqlite"));
		try {
			await use(storage);
		} finally {
			await storage.close(BACKGROUND_CONTEXT);
			await rm(directory, { recursive: true, force: true });
		}
	},
);
