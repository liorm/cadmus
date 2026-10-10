/** Installed for every bot. Not stored on the bot row. */
export const FILE_TOOLS = ["read", "write", "edit"] as const;

/** Stored on the bot row. Not registered as model tools yet. */
export const WEB_TOOLS = ["web.search", "web.fetch"] as const;

/** Providers the bot dialog offers. */
export const OFFERED_PROVIDERS = ["xai", "faux"] as const;
