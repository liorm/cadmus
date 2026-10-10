import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { Harness } from "@earendil-works/pi-durable";
import { DEFAULT_BOT_ID, type BotRecord, listBots, setTelegramToken } from "./channels/bots.ts";
import { listChats } from "./channels/telegram/chats.ts";
import { Deliverer } from "./channels/telegram/deliver.ts";
import { botCursor, generalCursor, TelegramPoller } from "./channels/telegram/poller.ts";
import { GrammyTransport, type TelegramTransport } from "./channels/telegram/transport.ts";
import { startWeb, type WebListener } from "./channels/web/server.ts";
import type { Config } from "./config.ts";
import { botEnv } from "./harness/bot-env.ts";
import { buildRegistry } from "./harness/registry.ts";
import { runStartup } from "./harness/startup.ts";
import { openOwnedStorage } from "./harness/storage.ts";
import { getLogger } from "./log.ts";
import { createBotRuntime, type BotRuntime, type TurnHooks } from "./runtime.ts";
import { armHarvest, HarvestNotesDoc, harvestId } from "./schedules/harvest.ts";
import { createScheduleService, type ScheduleService } from "./schedules/service.ts";

export type AppOptions = {
	config: Config;
	models: MutableModels;
	/** General door. Absent when `TELEGRAM_BOT_TOKEN` is unset; per-bot doors still open from stored tokens. */
	transport?: TelegramTransport;
	/** Start the long-poll loop (default true). Tests drive `poller.handleUpdate` directly when false. */
	poll?: boolean;
};

type BotDoor = { token: string; abort: AbortController; done: Promise<unknown>; poller: TelegramPoller };

export type App = {
	readonly harness: Harness;
	/** General-door poller. Absent when that door is off. */
	readonly poller?: TelegramPoller;
	readonly deliverer: Deliverer;
	/** Receipts reconciled to `unknown` at this startup. */
	readonly unknownAtStartup: readonly { chat: string; key: string }[];
	/** Bound page, when `WEB_TOKEN` is set. */
	readonly web?: { url: string };
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
				env: botEnv(),
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

	const { unknown } = await runStartup(harness, { home: config.home, model: config.model });
	const deliverer = new Deliverer(harness, transport);
	const hooks: TurnHooks = {};
	const runtimes = new Map<string, BotRuntime>();
	const addRuntime = (bot: BotRecord) => {
		const existing = runtimes.get(bot.id);
		if (existing) {
			existing.refresh(bot);
			return existing;
		}
		const created = createBotRuntime({ harness, deliverer, bot, home: config.home, hooks });
		runtimes.set(bot.id, created);
		return created;
	};
	for (const bot of await listBots(harness)) addRuntime(bot);
	const runtime = runtimes.get(DEFAULT_BOT_ID);
	if (!runtime) throw new Error("default bot is missing after startup");

	await harness.commit(async (tx) => {
		await tx.doc(HarvestNotesDoc);
	}, BACKGROUND_CONTEXT);
	const schedules = createScheduleService({
		home: config.home,
		timeZone: config.timeZone,
		harness,
		runtime: (id) => runtimes.get(id),
	});
	hooks.onInput = (chatKey) => schedules.remove(harvestId(chatKey));
	hooks.onSettled = (chatKey, entryId) => {
		const botId = chatKey.split(":")[0];
		if (!botId) return Promise.resolve();
		return armHarvest(schedules, { botId, chatKey, entryId, delayMs: config.harvestDelayMs });
	};
	schedules.start();

	const doors = new Map<string, BotDoor>();
	const openDoor = (bot: BotRecord) => {
		const token = bot.telegramToken;
		if (!token) return;
		const botRuntime = runtimes.get(bot.id);
		if (!botRuntime) return;
		const existing = doors.get(bot.id);
		if (existing?.token === token) return;
		if (existing) {
			existing.abort.abort();
			doors.delete(bot.id);
			deliverer.setBotTransport(bot.id, undefined);
			void existing.done.catch(() => {});
		}
		const botTransport = new GrammyTransport(token, config.telegram.apiRoot ? { apiRoot: config.telegram.apiRoot } : {});
		deliverer.setBotTransport(bot.id, botTransport);
		const doorPoller = new TelegramPoller({
			harness,
			runtime: botRuntime,
			transport: botTransport,
			deliverer,
			allowedUsers: config.telegram.allowedUsers,
			pollTimeoutSec: config.telegram.pollTimeoutSec,
			ingress: "bot",
			cursor: botCursor(harness, bot.id),
		});
		const abort = new AbortController();
		const done = doorPoller.run(abort.signal).catch((error) => getLogger().error("bot poll loop crashed", { error }));
		doors.set(bot.id, { token, abort, done, poller: doorPoller });
	};
	const closeDoor = async (botId: string) => {
		const existing = doors.get(botId);
		if (!existing) return;
		existing.abort.abort();
		doors.delete(botId);
		deliverer.setBotTransport(botId, undefined);
		await existing.done;
	};
	for (const bot of await listBots(harness)) openDoor(bot);

	let web: WebListener | undefined;
	if (config.web) {
		try {
			web = await startWeb(config.web, {
				config,
				models,
				harness,
				deliverer,
				ensureRuntime: (id) => runtimes.get(id),
				addRuntime,
				schedules,
				setTelegramDoor: async (botId, token) => {
					const bot = await setTelegramToken(harness, botId, token);
					if (!bot) return undefined;
					runtimes.get(botId)?.refresh(bot);
					if (bot.telegramToken) openDoor(bot);
					else await closeDoor(botId);
					return { telegramConfigured: Boolean(bot.telegramToken) };
				},
			});
		} catch (error) {
			await schedules.stop().catch(() => {});
			await harness.close(BACKGROUND_CONTEXT).catch(() => {});
			await lock.release();
			throw error;
		}
		log.info(`web ${web.url}`);
	}
	const poller = transport
		? new TelegramPoller({
				harness,
				runtime,
				transport,
				deliverer,
				allowedUsers: config.telegram.allowedUsers,
				pollTimeoutSec: config.telegram.pollTimeoutSec,
				ingress: "general",
				cursor: generalCursor(harness),
			})
		: undefined;

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
	const polling =
		poller && poll ? poller.run(abort.signal).catch((error) => getLogger().error("poll loop crashed", { error })) : Promise.resolve();
	log.info(`pi-bot started (model ${config.model.main.provider}/${config.model.main.modelId}, home ${config.home})`);

	let stopping: Promise<void> | undefined;
	return {
		harness,
		poller,
		deliverer,
		unknownAtStartup: unknown,
		...(web ? { web: { url: web.url } } : {}),
		async quiesce() {
			await harness.waitForIdle(BACKGROUND_CONTEXT);
			if (poller) await poller.settled();
			for (const door of doors.values()) await door.poller.settled();
			for (const bot of runtimes.values()) await bot.settled();
			await schedules.idle();
			for (const bot of runtimes.values()) await bot.settled();
			await deliverer.sweepAll();
			await deliverer.idle();
		},
		stop() {
			stopping ??= (async () => {
				abort.abort();
				for (const door of doors.values()) door.abort.abort();
				if (sweep) clearInterval(sweep);
				await polling;
				await Promise.all([...doors.values()].map((door) => door.done));
				await schedules.stop();
				if (web) await web.stop();
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
