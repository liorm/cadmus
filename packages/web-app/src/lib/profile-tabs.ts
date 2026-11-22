export const BOT_TABS = [
	"schedules",
	"memory",
	"skills",
	"soul",
	"config",
] as const;

export type BotTab = (typeof BOT_TABS)[number];

export function isBotTab(value: string): value is BotTab {
	return (BOT_TABS as readonly string[]).includes(value);
}
