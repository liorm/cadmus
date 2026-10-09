import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { type AgentChange, Harness } from "@earendil-works/pi-durable";
import { listChats } from "./channels/telegram/chats.ts";
import { Deliverer } from "./channels/telegram/deliver.ts";
import { TelegramPoller } from "./channels/telegram/poller.ts";
import type { TelegramTransport } from "./channels/telegram/transport.ts";
import type { Config } from "./config.ts";
import { buildRegistry } from "./harness/registry.ts";
import { runStartup } from "./harness/startup.ts";
import { openOwnedStorage } from "./harness/storage.ts";
import { getLogger } from "./log.ts";

export type AppOptions = {
	config: Config;
	models: MutableModels;
	transport: TelegramTransport;
	/** Start the long-poll loop (default true). Tests drive `poller.handleUpdate` directly when false. */
	poll?: boolean;
};

export type App = {
	readonly harness: Harness;
	readonly poller: TelegramPoller;
	readonly deliverer: Deliverer;
	/** Receipts reconciled to `unknown` at this startup. */
	readonly unknownAtStartup: readonly { chat: string; key: string }[];
	/** Wait until every chat is idle and every final answer has a receipt. */
	quiesce(): Promise<void>;
	stop(): Promise<void>;
};

export async function startApp({ config, models, transport, poll = true }: AppOptions): Promise<App> {
	const log = getLogger();
	await mkdir(join(config.home, "workspace"), { recursive: true });
	const { storage, lock } = await openOwnedStorage(config.home);
	let harness: Harness;
	try {
		const { registry } = buildRegistry({ home: config.home, timeZone: config.timeZone });
		harness = await Harness.open(
			storage,
			{
				models,
				registry,
				settings: {
					// Messages that arrive mid-run all join it at the next boundary.
					steeringMode: "all",
					// Native compaction (defaults: reserve 16k, keep 20k recent, background at 32k below the limit).
					compaction: { enabled: true },
				},
				onReport: (error) => getLogger().warn("pi-durable extension report", { error }),
			},
			BACKGROUND_CONTEXT,
		);
	} catch (error) {
		await storage.close(BACKGROUND_CONTEXT).catch(() => {});
		await lock.release();
		throw error;
	}

	const agent: AgentChange = { model: config.model.main, thinkingLevel: config.model.thinkingLevel ?? null };
	const { unknown } = await runStartup(harness, agent);
	const deliverer = new Deliverer(harness, transport);
	const poller = new TelegramPoller({
		harness,
		transport,
		deliverer,
		agent,
		allowedUsers: config.telegram.allowedUsers,
		pollTimeoutSec: config.telegram.pollTimeoutSec,
	});

	const background = new Set<Promise<unknown>>();
	const track = (work: Promise<unknown>) => {
		const tracked = work.catch((error) => getLogger().debug("background work ended", { error }));
		background.add(tracked);
		void tracked.finally(() => background.delete(tracked));
	};

	// Runs resumed from the last process: deliver their answers once they finish.
	for (const chat of await listChats(harness)) {
		track(
			(async () => {
				const conversation = await harness.conversation(chat.conversationId, BACKGROUND_CONTEXT);
				await conversation?.waitForIdle(BACKGROUND_CONTEXT);
				await deliverer.kick(chat);
			})(),
		);
	}
	// Safety net: answers whose watcher was lost still get delivered.
	const sweep = config.deliverySweepMs > 0 ? setInterval(() => void deliverer.sweepAll(), config.deliverySweepMs) : undefined;
	sweep?.unref();

	const abort = new AbortController();
	const polling = poll ? poller.run(abort.signal).catch((error) => getLogger().error("poll loop crashed", { error })) : Promise.resolve();
	log.info(`pi-bot started (model ${config.model.main.provider}/${config.model.main.modelId}, home ${config.home})`);

	let stopping: Promise<void> | undefined;
	return {
		harness,
		poller,
		deliverer,
		unknownAtStartup: unknown,
		async quiesce() {
			await harness.waitForIdle(BACKGROUND_CONTEXT);
			await poller.settled();
			await deliverer.sweepAll();
			await deliverer.idle();
		},
		stop() {
			stopping ??= (async () => {
				abort.abort();
				if (sweep) clearInterval(sweep);
				await polling;
				await deliverer.idle();
				await harness.close(BACKGROUND_CONTEXT);
				// Answer watchers of unfinished runs settle (or fail) once the harness is closed.
				await Promise.race([Promise.allSettled([...background]), new Promise((resolve) => setTimeout(resolve, 2000))]);
				await lock.release();
				log.info("pi-bot stopped");
			})();
			return stopping;
		},
	};
}
