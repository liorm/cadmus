import {
	BACKGROUND_CONTEXT,
	type Context,
	createContextKey,
	withContextValue,
} from "@earendil-works/chord/context";
import type { Harness, RegistryReader } from "@earendil-works/pi-durable";
import type { BotRuntime } from "./runtime.ts";
import type { StoredSchedule } from "./schedules/store.ts";

/** Sidecar operations a schedule task needs. Filled when the catalog is created. */
export type ScheduleCatalog = {
	get(id: string): StoredSchedule | undefined;
	setNextRun(id: string, nextRun: number): void;
	setTaskId(id: string, taskId: string): void;
	remove(id: string): void;
	claim(
		row: StoredSchedule,
		requestId: string,
		cronNext: number | undefined,
	): boolean;
};

/**
 * Process services tasks and the bot runtime share. One object is placed on the
 * harness context at open. Fields that exist only after open are filled before
 * `resume`. Tasks read this object from their context. Host code receives the same object.
 */
export type AppServices = {
	home: string;
	timeZone: string;
	registry: RegistryReader;
	harvestDelayMs: number;
	harness: Harness;
	runtime(botId: string): BotRuntime | undefined;
	catalog: ScheduleCatalog;
	track(work: Promise<void>): void;
	idle(): Promise<void>;
};

export const servicesKey = createContextKey<AppServices>("pi-bot.services");

export function appContext(services: AppServices): Context {
	return withContextValue(servicesKey, services, BACKGROUND_CONTEXT);
}

export function requireServices(context: Context): AppServices {
	const services = context.value(servicesKey);
	if (!services) throw new Error("pi-bot services are not on this context.");
	return services;
}
