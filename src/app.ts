import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { Harness } from "@earendil-works/pi-durable";
import { type BotRecord, DEFAULT_BOT_ID, listBots } from "./channels/bots.ts";
import { listChats } from "./channels/chats.ts";
import { startWeb, type WebListener } from "./channels/web/server.ts";
import type { Config } from "./config.ts";
import type { SelfHost } from "./extensions/self-tools/index.ts";
import { botEnv } from "./harness/bot-env.ts";
import { checkModel, parseModelRef } from "./harness/models.ts";
import { buildRegistry } from "./harness/registry.ts";
import { runStartup } from "./harness/startup.ts";
import { DEV_LOCK_WAIT_MS, openOwnedStorage } from "./harness/storage.ts";
import { HarvestNotesDoc } from "./harvest/notes.ts";
import { armIdleHarvest } from "./harvest/run.ts";
import { getLogger } from "./log.ts";
import { type BotRuntime, createBotRuntime } from "./runtime.ts";
import { createScheduleService } from "./schedules/service.ts";
import {
	type AppServices,
	appContext,
	type ScheduleCatalog,
} from "./services.ts";

export type AppOptions = {
	config: Config;
	models: MutableModels;
};

export type App = {
	readonly harness: Harness;
	/** Bound page, when `WEB_TOKEN` is set. */
	readonly web?: { url: string };
	/** Wait until every chat is idle. */
	quiesce(): Promise<void>;
	stop(): Promise<void>;
};

export async function startApp({ config, models }: AppOptions): Promise<App> {
	const log = getLogger();
	const { storage, lock } = await openOwnedStorage(
		config.home,
		config.dev ? { waitMs: DEV_LOCK_WAIT_MS, stealAfterWait: true } : undefined,
	);
	let harness: Harness;
	const now = () => Date.now();
	const self: SelfHost = { home: config.home };
	const { registry } = buildRegistry({
		home: config.home,
		timeZone: config.timeZone,
		self,
	});
	const services: AppServices = {
		home: config.home,
		timeZone: config.timeZone,
		registry,
		harvestDelayMs: config.harvestDelayMs,
		harness: undefined as unknown as Harness,
		runtime: () => undefined,
		catalog: undefined as unknown as ScheduleCatalog,
		track: () => {},
		idle: async () => {},
	};
	try {
		harness = await Harness.open(
			storage,
			{
				models,
				registry,
				now,
				env: botEnv(),
				settings: {
					// Messages that arrive mid-run all join it at the next boundary.
					steeringMode: "all",
					// Native compaction (defaults: reserve 16k, keep 20k recent, background at 32k below the limit).
					compaction: { enabled: true },
				},
				onReport: (error) =>
					getLogger().warn("pi-durable extension report", { error }),
			},
			appContext(services),
		);
		services.harness = harness;
	} catch (error) {
		await storage.close(BACKGROUND_CONTEXT).catch(() => {});
		await lock.release();
		throw error;
	}

	await runStartup(harness, {
		home: config.home,
		registry,
	});
	const runtimes = new Map<string, BotRuntime>();
	const addRuntime = (bot: BotRecord) => {
		const existing = runtimes.get(bot.id);
		if (existing) {
			existing.refresh(bot);
			return existing;
		}
		const created = createBotRuntime({
			harness,
			registry,
			bot,
			home: config.home,
			services,
		});
		runtimes.set(bot.id, created);
		return created;
	};
	const bots = await listBots(harness);
	try {
		for (const bot of bots) {
			const source = await checkModel(models, parseModelRef(bot.model));
			log.info(`Model auth for ${bot.id} (${bot.model}): ${source}`);
		}
	} catch (error) {
		await harness.close(BACKGROUND_CONTEXT).catch(() => {});
		await lock.release();
		throw error;
	}
	for (const bot of bots) addRuntime(bot);

	await harness.commit(async (tx) => {
		await tx.doc(HarvestNotesDoc);
	}, BACKGROUND_CONTEXT);
	services.runtime = (id) => runtimes.get(id);
	const schedules = createScheduleService({
		home: config.home,
		timeZone: config.timeZone,
		services,
		harness,
		registry,
		runtime: (id) => runtimes.get(id),
		now,
	});
	self.schedules = schedules;
	self.harness = harness;
	self.onBot = addRuntime;
	harness.resume();

	let web: WebListener | undefined;
	if (config.web) {
		try {
			web = await startWeb(config.web, {
				config,
				models,
				harness,
				registry,
				ensureRuntime: (id) => runtimes.get(id),
				addRuntime,
				schedules,
			});
		} catch (error) {
			await schedules.stop().catch(() => {});
			await harness.close(BACKGROUND_CONTEXT).catch(() => {});
			await lock.release();
			throw error;
		}
		log.info(`web ${web.url}`);
	}

	const background = new Set<Promise<unknown>>();
	const track = (work: Promise<unknown>) => {
		const tracked = work.catch((error) =>
			getLogger().debug("background work ended", { error }),
		);
		background.add(tracked);
		void tracked.finally(() => background.delete(tracked));
	};

	// Runs resumed from the last process.
	// Harvest is armed after idle so a crash mid-turn still gets a wake.
	for (const chat of await listChats(harness)) {
		track(
			(async () => {
				const conversation = await harness.conversation(
					chat.conversationId,
					BACKGROUND_CONTEXT,
				);
				await conversation?.waitForIdle(BACKGROUND_CONTEXT);
				await armIdleHarvest(services, {
					botId: chat.botId ?? DEFAULT_BOT_ID,
					chatKey: chat.key,
					conversationId: chat.conversationId,
				});
			})(),
		);
	}

	log.info(`pi-bot started (${bots.length} bots, home ${config.home})`);

	let stopping: Promise<void> | undefined;
	return {
		harness,
		...(web ? { web: { url: web.url } } : {}),
		async quiesce() {
			await harness.waitForIdle(BACKGROUND_CONTEXT);
			for (const bot of runtimes.values()) await bot.settled();
			await schedules.idle();
			for (const bot of runtimes.values()) await bot.settled();
		},
		stop() {
			stopping ??= (async () => {
				await schedules.stop();
				if (web) await web.stop();
				await harness.close(BACKGROUND_CONTEXT);
				// Answer watchers of unfinished runs settle (or fail) once the harness is closed.
				await Promise.race([
					Promise.allSettled([...background]),
					new Promise((resolve) => setTimeout(resolve, 2000)),
				]);
				await lock.release();
				log.info("pi-bot stopped");
			})();
			return stopping;
		},
	};
}
