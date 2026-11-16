import { toBase64Url } from "../src/base64url.js";

/**
 * A minimal software authenticator for route tests: ES256, "none" attestation,
 * user verification set. Primitives are copied from webauthn.test.ts.
 */
const te = new TextEncoder();

const cat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
};
const sha = async (d: Uint8Array) =>
	new Uint8Array(await crypto.subtle.digest("SHA-256", d as BufferSource));
const u32 = (n: number) =>
	new Uint8Array([
		(n >>> 24) & 255,
		(n >>> 16) & 255,
		(n >>> 8) & 255,
		n & 255,
	]);

async function newKey() {
	const kp = (await crypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" },
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	const raw = new Uint8Array(
		(await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer,
	);
	// COSE_Key {1:2, 3:-7, -1:1, -2:x, -3:y}
	const cose = cat(
		new Uint8Array([
			0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20,
		]),
		raw.slice(1, 33),
		new Uint8Array([0x22, 0x58, 0x20]),
		raw.slice(33),
	);
	return { kp, cose };
}

const derInt = (v: Uint8Array) => {
	let i = 0;
	while (i < v.length - 1 && v[i] === 0) i++;
	let out = v.slice(i);
	if (out[0] & 0x80) out = cat(new Uint8Array([0]), out);
	return cat(new Uint8Array([0x02, out.length]), out);
};
async function sign(kp: CryptoKeyPair, data: Uint8Array) {
	const raw = new Uint8Array(
		await crypto.subtle.sign(
			{ name: "ECDSA", hash: "SHA-256" },
			kp.privateKey,
			data as BufferSource,
		),
	);
	const body = cat(derInt(raw.slice(0, 32)), derInt(raw.slice(32)));
	return cat(new Uint8Array([0x30, body.length]), body);
}

export async function newAuthenticator(credentialId: Uint8Array) {
	const key = await newKey();
	const id = toBase64Url(credentialId);
	const clientData = (type: string, challenge: string, origin: string) =>
		te.encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
	return {
		id,
		async register(o: { challenge: string; origin: string; rpId: string }) {
			const authData = cat(
				await sha(te.encode(o.rpId)),
				new Uint8Array([0x01 | 0x40 | 0x04]),
				u32(0),
				new Uint8Array(16),
				new Uint8Array([0, credentialId.length]),
				credentialId,
				key.cose,
			);
			const text = (v: string) =>
				cat(new Uint8Array([0x60 + v.length]), te.encode(v));
			const att = cat(
				new Uint8Array([0xa3]),
				text("fmt"),
				text("none"),
				text("attStmt"),
				new Uint8Array([0xa0]),
				text("authData"),
				new Uint8Array([0x59, authData.length >> 8, authData.length & 255]),
				authData,
			);
			return {
				id,
				rawId: id,
				type: "public-key" as const,
				clientExtensionResults: {},
				response: {
					clientDataJSON: toBase64Url(
						clientData("webauthn.create", o.challenge, o.origin),
					),
					attestationObject: toBase64Url(att),
					transports: ["internal" as const],
				},
			};
		},
		async assert(o: {
			challenge: string;
			origin: string;
			rpId: string;
			counter: number;
			userHandle: string;
		}) {
			const authData = cat(
				await sha(te.encode(o.rpId)),
				new Uint8Array([0x01 | 0x04]),
				u32(o.counter),
			);
			const cd = clientData("webauthn.get", o.challenge, o.origin);
			const signature = await sign(key.kp, cat(authData, await sha(cd)));
			return {
				id,
				rawId: id,
				type: "public-key" as const,
				clientExtensionResults: {},
				response: {
					clientDataJSON: toBase64Url(cd),
					authenticatorData: toBase64Url(authData),
					signature: toBase64Url(signature),
					userHandle: o.userHandle,
				},
			};
		},
	};
}
