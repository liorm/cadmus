import { fromBase64Url, toBase64Url } from "../base64url.js";
import { isProductionDeploy } from "../env-overrides.js";
import { getLogger } from "../log.js";
import type { Env } from "../types.js";

/**
 * Local-development password login (issue #3 phase 5).
 *
 * Off unless CADMUS_DEV_PASSWORD_LOGIN=1 and CADMUS_DEV_PASSWORD_HASH are set.
 * When switched on it still fails loudly (500 and a log line) unless the host
 * is localhost, 127.0.0.1 or [::1], IS_PREVIEW is unset and the deployment is
 * not production. wrangler.jsonc never sets CADMUS_DEV_PASSWORD_* (a test
 * asserts it), so production and previews cannot enable it by config.
 *
 * Hash format: pbkdf2-sha256$<iterations>$<salt b64url>$<hash b64url>
 * (see scripts/hash-dev-password.ts). The guard refuses when either
 * CADMUS_DEPLOY_ENV (set to "production" in the top-level wrangler vars) or
 * the spec's CADMUS_ENV is the string "production". CADMUS_ENV is also the
 * tools-env Durable Object binding in this repo; an object value is ignored.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_ITERATIONS = 1_000_000;

export type DevPasswordState =
	| { state: "off" }
	| { state: "refused"; reason: string }
	| { state: "on"; hash: string };

function isAllowedDevHost(hostname: string, extraHosts?: string): boolean {
	if (LOCAL_HOSTS.has(hostname)) return true;
	if (!extraHosts) return false;
	for (const entry of extraHosts.split(",")) {
		if (entry.trim() === hostname) return true;
	}
	return false;
}

export function devPasswordState(
	env: Omit<Partial<Env>, "CADMUS_ENV"> & {
		CADMUS_DEV_PASSWORD_LOGIN?: string;
		CADMUS_DEV_PASSWORD_HASH?: string;
		CADMUS_DEV_ALLOWED_HOSTS?: string;
		CADMUS_DEPLOY_ENV?: string;
		CADMUS_ENV?: unknown;
	},
	url: URL,
): DevPasswordState {
	const hash = env.CADMUS_DEV_PASSWORD_HASH?.trim();
	if (env.CADMUS_DEV_PASSWORD_LOGIN !== "1" || !hash) return { state: "off" };
	if (!isAllowedDevHost(url.hostname, env.CADMUS_DEV_ALLOWED_HOSTS)) {
		return { state: "refused", reason: "host_not_local" };
	}
	if (env.IS_PREVIEW) return { state: "refused", reason: "preview" };
	if (
		isProductionDeploy(env.CADMUS_DEPLOY_ENV) ||
		isProductionDeploy(env.CADMUS_ENV)
	) {
		return { state: "refused", reason: "production" };
	}
	return { state: "on", hash };
}

export async function hashDevPassword(
	password: string,
	options: { iterations?: number; salt?: Uint8Array } = {},
): Promise<string> {
	const iterations = options.iterations ?? 210_000;
	const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
	const bits = await derive(password, salt, iterations);
	return `pbkdf2-sha256$${iterations}$${toBase64Url(salt)}$${toBase64Url(bits)}`;
}

async function derive(
	password: string,
	salt: Uint8Array,
	iterations: number,
): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password),
		"PBKDF2",
		false,
		["deriveBits"],
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-256", salt, iterations },
		key,
		256,
	);
	return new Uint8Array(bits);
}

export async function verifyDevPassword(
	password: string,
	stored: string,
): Promise<boolean> {
	const [scheme, iterText, saltText, hashText] = stored.split("$");
	if (scheme !== "pbkdf2-sha256" || !iterText || !saltText || !hashText) {
		getLogger().error("dev password hash is malformed");
		return false;
	}
	const iterations = Number(iterText);
	if (
		!Number.isInteger(iterations) ||
		iterations < 1 ||
		iterations > MAX_ITERATIONS
	) {
		return false;
	}
	const expected = fromBase64Url(hashText);
	const actual = await derive(password, fromBase64Url(saltText), iterations);
	if (expected.length !== actual.length) return false;
	let diff = 0;
	for (let i = 0; i < actual.length; i++) {
		diff |= (actual[i] ?? 0) ^ (expected[i] ?? 0);
	}
	return diff === 0;
}
