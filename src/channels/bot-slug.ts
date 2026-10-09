const BOT_SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * A bot id from a display name: lowercase, punctuation runs become one `-`, cut to 32 characters.
 * `undefined` when nothing legal remains.
 */
export function slugifyBotName(name: string): string | undefined {
	const slug = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!slug) return undefined;
	const cut = slug.slice(0, 32).replace(/-+$/g, "");
	return BOT_SLUG.test(cut) ? cut : undefined;
}
