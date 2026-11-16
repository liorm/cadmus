import { toBase64Url } from "../base64url.js";

/** Hex id for a D1 row. Login ids pass 12 bytes; every other caller uses 8. */
export function randomId(prefix: string, byteLength = 8): string {
	const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
	return `${prefix}${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** 32 random bytes, unpadded base64url, with a caller-supplied prefix. */
export function randomToken(prefix: string): string {
	return `${prefix}${toBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
}
