/**
 * Local dev login lives only in the repo-root `.dev.vars`.
 * `wrangler.jsonc` stays on CADMUS_DEPLOY_ENV=production and never carries
 * the password hash, so a missing file must stop `bun run dev`.
 */

export const DEV_VARS_FILE = ".dev.vars";

const REQUIRED = [
	"CADMUS_DEV_PASSWORD_LOGIN",
	"CADMUS_DEV_PASSWORD_HASH",
	"CADMUS_BOOTSTRAP_SUPER_ADMIN_EMAIL",
	"CADMUS_DEPLOY_ENV",
] as const;

const HASH = /^pbkdf2-sha256\$[1-9][0-9]*\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/;

export function parseDevVars(text: string): Map<string, string> {
	const vars = new Map<string, string>();
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		const key = trimmed.slice(0, eq).trim();
		let value = trimmed.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		vars.set(key, value);
	}
	return vars;
}

/** Human-readable problems. Empty means `bun run dev` may start. */
export function devLoginProblems(text: string | null): string[] {
	if (text === null) {
		return [`${DEV_VARS_FILE} is missing`];
	}
	const vars = parseDevVars(text);
	const problems: string[] = [];
	if (vars.get("CADMUS_DEV_PASSWORD_LOGIN") !== "1") {
		problems.push("CADMUS_DEV_PASSWORD_LOGIN must be 1");
	}
	const hash = vars.get("CADMUS_DEV_PASSWORD_HASH") ?? "";
	if (!HASH.test(hash)) {
		problems.push(
			"CADMUS_DEV_PASSWORD_HASH must be a pbkdf2-sha256 hash from dev:setup",
		);
	}
	const email = vars.get("CADMUS_BOOTSTRAP_SUPER_ADMIN_EMAIL") ?? "";
	if (!email.includes("@")) {
		problems.push(
			"CADMUS_BOOTSTRAP_SUPER_ADMIN_EMAIL must be the bootstrap email",
		);
	}
	const deploy = (vars.get("CADMUS_DEPLOY_ENV") ?? "").trim().toLowerCase();
	if (deploy === "" || deploy === "production") {
		problems.push(
			"CADMUS_DEPLOY_ENV must be development in .dev.vars (production refuses dev login)",
		);
	}
	return problems;
}

export function devLoginHelp(): string {
	return [
		"Dev login is not set, so the web app would open with no sign-in method.",
		"Create .dev.vars first:",
		"  bun run dev:setup",
	].join("\n");
}

/** Replace the dev-login keys and keep every other line. */
export function upsertDevLogin(
	existing: string,
	values: Record<(typeof REQUIRED)[number], string>,
): string {
	const keys = new Set<string>(REQUIRED);
	const kept = existing
		.split("\n")
		.filter((line) => {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) return true;
			const eq = trimmed.indexOf("=");
			if (eq <= 0) return true;
			return !keys.has(trimmed.slice(0, eq).trim());
		})
		.join("\n")
		.replace(/\n+$/, "");
	const block = REQUIRED.map((key) => `${key}=${values[key]}`).join("\n");
	return `${kept}${kept ? "\n" : ""}${block}\n`;
}
