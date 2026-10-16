/**
 * Id the general Telegram door (`TELEGRAM_BOT_TOKEN`) admits on.
 * Nothing creates this row. It exists when a bot was named so its slug is `default`, or when an older home already had one.
 */
export const DEFAULT_BOT_ID = "default";

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
