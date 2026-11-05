import type { BotRecord } from "@cadmus/contract/types";

export const BOT_PALETTE_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
export type BotPaletteSlot = (typeof BOT_PALETTE_SLOTS)[number];

export type BotColorSource = Pick<BotRecord, "id" | "metadata">;

function isSlot(value: number): value is BotPaletteSlot {
	return Number.isInteger(value) && value >= 1 && value <= 8;
}

/** Stable djb2-ish hash of the bot id into palette slots 1–8. */
export function hashBotIdToSlot(id: string): BotPaletteSlot {
	let hash = 5381;
	for (let i = 0; i < id.length; i += 1) {
		hash = (hash * 33) ^ id.charCodeAt(i);
	}
	const slot = (Math.abs(hash) % 8) + 1;
	return slot as BotPaletteSlot;
}

function parseColor(value: string | undefined): BotPaletteSlot | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	const fromToken = /^bot-([1-8])$/.exec(trimmed);
	if (fromToken?.[1]) return Number(fromToken[1]) as BotPaletteSlot;
	const asNumber = Number(trimmed);
	if (isSlot(asNumber)) return asNumber;
	return undefined;
}

export function botColor(bot: BotColorSource): BotPaletteSlot {
	const fromMeta = parseColor(bot.metadata?.color);
	if (fromMeta) return fromMeta;
	return hashBotIdToSlot(bot.id);
}

export function botColorVar(slot: BotPaletteSlot): string {
	return `var(--bot-${slot})`;
}

/** Palette slot shown before a bot id exists. Stable for a given name. */
export function derivedBotColor(name: string): BotPaletteSlot {
	const key = name.trim().toLowerCase() || "bot";
	return hashBotIdToSlot(key);
}

/** Up to two initials for the live avatar on the new-bot screen. */
export function botInitials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return "•";
	const first = parts[0] ?? "";
	if (parts.length === 1) return first.slice(0, 2).toUpperCase();
	return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
}
