/** How many model replies `search_bot` reads before it gives up on a bad slug. */
export const SEARCH_ROUNDS = 3;

/** Soul characters copied into the search catalog. */
export const SOUL_EXCERPT = 400;

/** Bots listed in one search. The rest are counted and left out. */
export const SEARCH_BOT_CAP = 40;

export const SEARCH_INSTRUCTIONS = `You match one request to one bot in the catalog the user sends.
Reply with that bot's slug and nothing else. Copy the slug exactly.
If none match, reply with nothing, or the single word null.`;

export type CatalogBot = {
	slug: string;
	name: string;
	model: string;
	soul: string;
	knowledge?: string;
};

export type ParsedSearchAnswer =
	| { kind: "slug"; slug: string }
	| { kind: "none" }
	| { kind: "invalid" };

/** Trim a soul for the catalog. */
export function excerptSoul(text: string): string {
	const flat = text.trim();
	if (flat.length <= SOUL_EXCERPT) return flat;
	return `${flat.slice(0, SOUL_EXCERPT)}…`;
}

/**
 * Stable catalog text and the slugs the model is allowed to return.
 * Bots past the cap are counted and omitted, so their slugs are not allowed.
 */
export function formatSearchCatalog(bots: readonly CatalogBot[]): {
	text: string;
	slugs: string[];
} {
	const ordered = [...bots].sort((a, b) => a.slug.localeCompare(b.slug));
	const shown = ordered.slice(0, SEARCH_BOT_CAP);
	const blocks = shown.map((bot) => {
		const lines = [
			`slug: ${bot.slug}`,
			`name: ${bot.name}`,
			`model: ${bot.model}`,
			`soul: ${bot.soul || "(empty)"}`,
		];
		if (bot.knowledge) lines.push(`knowledge:\n${bot.knowledge}`);
		return lines.join("\n");
	});
	if (ordered.length > shown.length) {
		blocks.push(`${ordered.length - shown.length} more bots are not listed.`);
	}
	const text = blocks.join("\n\n");
	return {
		text: text || "No bots are stored.",
		slugs: shown.map((bot) => bot.slug),
	};
}

/**
 * Empty, or `null` when that word is not itself a catalog slug, means no match.
 * Any other text that is not an exact slug is invalid and may be asked again.
 */
export function parseSearchAnswer(
	text: string,
	slugs: readonly string[],
): ParsedSearchAnswer {
	const trimmed = text.trim();
	if (!trimmed) return { kind: "none" };
	if (slugs.includes(trimmed)) return { kind: "slug", slug: trimmed };
	if (/^null$/i.test(trimmed)) return { kind: "none" };
	return { kind: "invalid" };
}

export function searchRequest(catalog: string, description: string): string {
	return `Catalog:\n${catalog}\n\nRequest:\n${description}`;
}

/** Tell the model its previous reply was not a catalog slug. */
export function searchRetry(answer: string): string {
	const shown = answer.trim().slice(0, 200);
	return `"${shown}" is not a catalog slug. Reply with one exact slug from the catalog, or null if none match.`;
}
