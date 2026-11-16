/** Unpadded base64url (RFC 4648 §5) for raw bytes and for UTF-8 strings. */

export function toBase64Url(value: Uint8Array | string): string {
	const bytes =
		typeof value === "string" ? new TextEncoder().encode(value) : value;
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decoded bytes. The buffer is a plain ArrayBuffer, safe for WebCrypto. */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
	const padded = text.replace(/-/g, "+").replace(/_/g, "/");
	const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
	return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function fromBase64UrlString(text: string): string {
	return new TextDecoder().decode(fromBase64Url(text));
}
