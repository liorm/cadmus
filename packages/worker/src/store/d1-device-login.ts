import { sha256Hex } from "../edge-cache.js";
import type { SessionIdentity, SessionTokens } from "./d1-sessions.js";
import { createSession } from "./d1-sessions.js";
import { randomId, randomToken } from "./random-id.js";

/** Human-facing code lifetime. The CLI polls until this passes. */
export const DEVICE_TTL_MS = 15 * 60 * 1000;
/** Seconds between polls. Returned to the client; the worker does not sleep. */
export const DEVICE_POLL_INTERVAL_SEC = 5;

const DEVICE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface DeviceLoginStart {
	deviceCode: string;
	deviceSecret: string;
	interval: number;
	expiresIn: number;
}

export type DevicePollResult =
	| { ok: true; status: "pending" }
	| {
			ok: true;
			status: "approved";
			tokens: SessionTokens;
			accountId: string;
			userId: string;
	  }
	| { ok: false; code: "unauthorized" };

export type DeviceDecisionResult =
	| { ok: true }
	| { ok: false; code: "unauthorized" | "provisional_session" };

function deviceCode(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	let raw = "";
	for (const byte of bytes) {
		raw += DEVICE_ALPHABET[byte % DEVICE_ALPHABET.length];
	}
	return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function normalizeDeviceCode(code: string): string {
	return code.replace(/-/g, "").trim().toUpperCase();
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
}

async function aesKey(encryptionKey: string): Promise<CryptoKey> {
	const material = await crypto.subtle.digest(
		"SHA-256",
		encoder.encode(`cadmus-device-v1:${encryptionKey}`),
	);
	return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, [
		"encrypt",
		"decrypt",
	]);
}

async function seal(encryptionKey: string, value: unknown): Promise<string> {
	const key = await aesKey(encryptionKey);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const encrypted = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		key,
		encoder.encode(JSON.stringify(value)),
	);
	return `${toHex(iv)}.${toHex(new Uint8Array(encrypted))}`;
}

async function open<T>(encryptionKey: string, blob: string): Promise<T> {
	const [ivHex, cipherHex] = blob.split(".");
	if (!ivHex || !cipherHex) throw new Error("bad device token blob");
	const key = await aesKey(encryptionKey);
	const decrypted = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: fromHex(ivHex) as BufferSource },
		key,
		fromHex(cipherHex) as BufferSource,
	);
	return JSON.parse(decoder.decode(decrypted)) as T;
}

export async function startDeviceLogin(
	db: D1Database,
	input: { now?: number; userAgent?: string; ipCountry?: string } = {},
): Promise<DeviceLoginStart> {
	const now = input.now ?? Date.now();
	const code = deviceCode();
	const secret = randomToken("cad_ds_");
	const id = randomId("dev_", 12);
	await db
		.prepare(
			`INSERT INTO cadmus_device_logins
         (id, device_code_hash, device_secret_hash, status, expires_at, created_at,
          user_agent, ip_country)
       VALUES (?1, ?2, ?3, 'pending', ?4, ?5, ?6, ?7)`,
		)
		.bind(
			id,
			await sha256Hex(normalizeDeviceCode(code)),
			await sha256Hex(secret),
			now + DEVICE_TTL_MS,
			now,
			input.userAgent ?? null,
			input.ipCountry ?? null,
		)
		.run();
	return {
		deviceCode: code,
		deviceSecret: secret,
		interval: DEVICE_POLL_INTERVAL_SEC,
		expiresIn: DEVICE_TTL_MS / 1000,
	};
}

interface DeviceRow {
	status: string;
	expires_at: number;
	token_blob: string | null;
	account_id: string | null;
	user_id: string | null;
}

export async function pollDeviceLogin(
	db: D1Database,
	encryptionKey: string,
	deviceSecret: string,
	now = Date.now(),
): Promise<DevicePollResult> {
	const hash = await sha256Hex(deviceSecret);
	const row = await db
		.prepare(
			`SELECT status, expires_at, token_blob, account_id, user_id
         FROM cadmus_device_logins WHERE device_secret_hash = ?1`,
		)
		.bind(hash)
		.first<DeviceRow>();
	if (!row || row.expires_at <= now) return { ok: false, code: "unauthorized" };
	if (row.status === "pending") return { ok: true, status: "pending" };
	if (
		row.status !== "approved" ||
		!row.token_blob ||
		!row.account_id ||
		!row.user_id
	) {
		return { ok: false, code: "unauthorized" };
	}
	const consumed = await db
		.prepare(
			`UPDATE cadmus_device_logins
         SET status = 'consumed', token_blob = NULL
       WHERE device_secret_hash = ?1 AND status = 'approved'`,
		)
		.bind(hash)
		.run();
	if ((consumed.meta.changes ?? 0) !== 1) {
		return { ok: false, code: "unauthorized" };
	}
	const tokens = await open<SessionTokens>(encryptionKey, row.token_blob);
	return {
		ok: true,
		status: "approved",
		tokens,
		accountId: row.account_id,
		userId: row.user_id,
	};
}

export async function approveDeviceLogin(
	db: D1Database,
	encryptionKey: string,
	input: { deviceCode: string; identity: SessionIdentity; now?: number },
): Promise<DeviceDecisionResult> {
	if (input.identity.provisional) {
		return { ok: false, code: "provisional_session" };
	}
	const now = input.now ?? Date.now();
	const hash = await sha256Hex(normalizeDeviceCode(input.deviceCode));
	const row = await db
		.prepare(
			`SELECT status, expires_at, user_agent, ip_country FROM cadmus_device_logins
         WHERE device_code_hash = ?1`,
		)
		.bind(hash)
		.first<{
			status: string;
			expires_at: number;
			user_agent: string | null;
			ip_country: string | null;
		}>();
	if (!row) return { ok: false, code: "unauthorized" };
	if (row.status !== "pending" || row.expires_at <= now) {
		return { ok: false, code: "unauthorized" };
	}
	const tokens = await createSession(db, {
		userId: input.identity.userId,
		accountId: input.identity.accountId,
		activeRole: input.identity.role,
		profile: "cli",
		userAgent: row.user_agent ?? "Cadmus CLI",
		ipCountry: row.ip_country ?? undefined,
		now,
	});
	const blob = await seal(encryptionKey, tokens);
	const updated = await db
		.prepare(
			`UPDATE cadmus_device_logins
         SET status = 'approved', user_id = ?2, account_id = ?3, role = ?4, token_blob = ?5
       WHERE device_code_hash = ?1 AND status = 'pending' AND expires_at > ?6`,
		)
		.bind(
			hash,
			input.identity.userId,
			input.identity.accountId,
			input.identity.role,
			blob,
			now,
		)
		.run();
	if ((updated.meta.changes ?? 0) !== 1) {
		return { ok: false, code: "unauthorized" };
	}
	return { ok: true };
}

export async function denyDeviceLogin(
	db: D1Database,
	deviceCode: string,
	now = Date.now(),
): Promise<DeviceDecisionResult> {
	const hash = await sha256Hex(normalizeDeviceCode(deviceCode));
	const updated = await db
		.prepare(
			`UPDATE cadmus_device_logins
         SET status = 'denied'
       WHERE device_code_hash = ?1 AND status = 'pending' AND expires_at > ?2`,
		)
		.bind(hash, now)
		.run();
	if ((updated.meta.changes ?? 0) !== 1) {
		return { ok: false, code: "unauthorized" };
	}
	return { ok: true };
}
