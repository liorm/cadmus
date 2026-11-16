import { describe, expect, it } from "vitest";
import {
	relyingPartyFromUrl,
	verifyPasskeyAuthentication,
	verifyPasskeyRegistration,
} from "../src/auth/webauthn";
import { fromBase64Url, toBase64Url } from "../src/base64url";

const te = new TextEncoder();
const RP = { id: "app.example.com", origin: "https://app.example.com" };

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

interface Opts {
	challenge?: string;
	origin?: string;
	rpId?: string;
	type?: string;
	uv?: boolean;
	counter?: number;
}
const clientData = (o: Opts, fallbackType: string) =>
	te.encode(
		JSON.stringify({
			type: o.type ?? fallbackType,
			challenge: o.challenge ?? "chal",
			origin: o.origin ?? RP.origin,
			crossOrigin: false,
		}),
	);

const CRED_ID = new Uint8Array(16).map((_, i) => i + 1);
const credId = toBase64Url(CRED_ID);

async function registration(
	key: Awaited<ReturnType<typeof newKey>>,
	o: Opts = {},
	cose = key.cose,
	fmt: "none" | "packed" | "packed-empty" = "none",
) {
	const rpHash = await sha(te.encode(o.rpId ?? RP.id));
	const flags = 0x01 | 0x40 | (o.uv === false ? 0 : 0x04);
	const authData = cat(
		rpHash,
		new Uint8Array([flags]),
		u32(o.counter ?? 0),
		new Uint8Array(16),
		new Uint8Array([0, CRED_ID.length]),
		CRED_ID,
		cose,
	);
	const cdHash = await sha(clientData(o, "webauthn.create"));
	const text = (v: string) =>
		cat(new Uint8Array([0x60 + v.length]), te.encode(v));
	let attStmt = new Uint8Array([0xa0]);
	if (fmt === "packed") {
		// self attestation {"alg":-7,"sig":bytes}
		const sig = await sign(key.kp, cat(authData, cdHash));
		attStmt = cat(
			new Uint8Array([0xa2]),
			text("alg"),
			new Uint8Array([0x26]),
			text("sig"),
			new Uint8Array([0x58, sig.length]),
			sig,
		);
	}
	// {"fmt":...,"attStmt":...,"authData":bytes}
	const att = cat(
		new Uint8Array([0xa3]),
		text("fmt"),
		text(fmt === "none" ? "none" : "packed"),
		text("attStmt"),
		attStmt,
		text("authData"),
		new Uint8Array([0x59, authData.length >> 8, authData.length & 255]),
		authData,
	);
	return {
		id: credId,
		rawId: credId,
		type: "public-key" as const,
		clientExtensionResults: {},
		response: {
			clientDataJSON: toBase64Url(clientData(o, "webauthn.create")),
			attestationObject: toBase64Url(att),
			transports: ["internal" as const],
		},
	};
}

interface Tamper {
	authData?: (a: Uint8Array) => Uint8Array;
	clientData?: (c: Uint8Array) => Uint8Array;
	userHandle?: string;
	id?: string;
}
async function assertion(signer: CryptoKeyPair, o: Opts = {}, t: Tamper = {}) {
	const authData = cat(
		await sha(te.encode(o.rpId ?? RP.id)),
		new Uint8Array([0x01 | (o.uv === false ? 0 : 0x04)]),
		u32(o.counter ?? 5),
	);
	const cd = clientData(o, "webauthn.get");
	const signature = await sign(signer, cat(authData, await sha(cd)));
	return {
		id: t.id ?? credId,
		rawId: t.id ?? credId,
		type: "public-key" as const,
		clientExtensionResults: {},
		response: {
			clientDataJSON: toBase64Url(t.clientData ? t.clientData(cd) : cd),
			authenticatorData: toBase64Url(
				t.authData ? t.authData(authData) : authData,
			),
			signature: toBase64Url(signature),
			userHandle: t.userHandle,
		},
	};
}

async function stored(counter = 0) {
	const key = await newKey();
	return {
		key,
		credential: { id: credId, publicKey: toBase64Url(key.cose), counter },
	};
}
const run = (
	response: Awaited<ReturnType<typeof assertion>>,
	credential: { id: string; publicKey: string; counter: number },
	extra: { expectedUserHandle?: string; challenge?: string } = {},
) =>
	verifyPasskeyAuthentication({
		response,
		expectedChallenge: extra.challenge ?? "chal",
		rp: RP,
		credential,
		expectedUserHandle: extra.expectedUserHandle ?? null,
	});

describe("relyingPartyFromUrl", () => {
	it("derives id and origin from https and fails closed otherwise", () => {
		expect(relyingPartyFromUrl("https://app.example.com/x?y")).toEqual(RP);
		expect(relyingPartyFromUrl("")).toBeNull();
		expect(relyingPartyFromUrl(undefined)).toBeNull();
		expect(relyingPartyFromUrl("not a url")).toBeNull();
		expect(relyingPartyFromUrl("http://app.example.com")).toBeNull();
		expect(relyingPartyFromUrl("https://1.2.3.4")).toBeNull();
		expect(relyingPartyFromUrl("https://0x7f.1")).toBeNull();
		expect(relyingPartyFromUrl("https://[::1]")).toBeNull();
		expect(relyingPartyFromUrl("https://cadmus.example.workers.dev")).toEqual({
			id: "cadmus.example.workers.dev",
			origin: "https://cadmus.example.workers.dev",
		});
		expect(relyingPartyFromUrl("https://u:p@app.example.com")).toBeNull();
		expect(relyingPartyFromUrl("http://localhost:8787")).toEqual({
			id: "localhost",
			origin: "http://localhost:8787",
		});
	});
	it("round-trips base64url", () => {
		const bytes = new Uint8Array([0, 250, 251, 252, 253, 254, 255]);
		expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
	});
});

describe("registration", () => {
	it("accepts a valid none-attestation ES256 registration and returns the typed key", async () => {
		const key = await newKey();
		const result = await verifyPasskeyRegistration({
			response: await registration(key),
			expectedChallenge: "chal",
			rp: RP,
		});
		expect(result).toEqual({
			ok: true,
			credentialId: credId,
			publicKey: toBase64Url(key.cose),
			counter: 0,
			transports: ["internal"],
			deviceType: "singleDevice",
			backedUp: false,
		});
	});

	it("rejects a self-attested packed registration as unsupported_attestation", async () => {
		const key = await newKey();
		const result = await verifyPasskeyRegistration({
			response: await registration(key, {}, key.cose, "packed"),
			expectedChallenge: "chal",
			rp: RP,
		});
		expect(result).toEqual({
			ok: false,
			reason: "unsupported_attestation",
			detail: "packed",
		});
	});

	it("returns a typed rejection, not a throw, for a packed statement it cannot verify", async () => {
		const key = await newKey();
		const result = await verifyPasskeyRegistration({
			response: await registration(key, {}, key.cose, "packed-empty"),
			expectedChallenge: "chal",
			rp: RP,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("verification_failed");
	});

	const bad: [string, Opts, RegExp][] = [
		["wrong challenge", { challenge: "other" }, /challenge/i],
		["wrong origin", { origin: "https://evil.example.com" }, /origin/i],
		["wrong rp id hash", { rpId: "evil.example.com" }, /rp id|rpid/i],
		["wrong client data type", { type: "webauthn.get" }, /type/i],
		["no user verification", { uv: false }, /verif/i],
	];
	for (const [name, opts, detail] of bad) {
		it(`rejects ${name} with a specific reason`, async () => {
			const key = await newKey();
			const result = await verifyPasskeyRegistration({
				response: await registration(key, opts),
				expectedChallenge: "chal",
				rp: RP,
			});
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toBe("verification_failed");
				expect(result.detail).toMatch(detail);
			}
		});
	}

	it("rejects a non-ES256 key (EdDSA) even though the library knows it", async () => {
		const key = await newKey();
		// COSE OKP/Ed25519 key {1:1, 3:-8, -1:6, -2:x}
		const ed = cat(
			new Uint8Array([
				0xa4, 0x01, 0x01, 0x03, 0x27, 0x20, 0x06, 0x21, 0x58, 0x20,
			]),
			new Uint8Array(32).fill(7),
		);
		const result = await verifyPasskeyRegistration({
			response: await registration(key, {}, ed),
			expectedChallenge: "chal",
			rp: RP,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.detail).toMatch(/algorithm|alg/i);
	});

	it("rejects when response.id differs from the attested credential id", async () => {
		const key = await newKey();
		const response = await registration(key);
		const result = await verifyPasskeyRegistration({
			response: { ...response, id: "AAAA", rawId: "AAAA" },
			expectedChallenge: "chal",
			rp: RP,
		});
		expect(result).toEqual({
			ok: false,
			reason: "wrong_credential",
			detail: "id mismatch",
		});
	});
});

describe("authentication", () => {
	it("accepts a valid assertion and returns the new counter", async () => {
		const { key, credential } = await stored(0);
		expect(await run(await assertion(key.kp), credential)).toEqual({
			ok: true,
			newCounter: 5,
		});
	});

	it("accepts a counterless authenticator (0 then 0) and rejects a stored counter that drops to 0", async () => {
		const zero = await stored(0);
		expect(
			await run(await assertion(zero.key.kp, { counter: 0 }), zero.credential),
		).toEqual({
			ok: true,
			newCounter: 0,
		});
		const used = await stored(5);
		const dropped = await run(
			await assertion(used.key.kp, { counter: 0 }),
			used.credential,
		);
		expect(dropped.ok).toBe(false);
		if (!dropped.ok) expect(dropped.detail).toMatch(/counter/i);
	});

	it("rejects a replayed counter and accepts only a higher one", async () => {
		const { key, credential } = await stored(5);
		const replay = await run(
			await assertion(key.kp, { counter: 5 }),
			credential,
		);
		expect(replay.ok).toBe(false);
		if (!replay.ok) expect(replay.detail).toMatch(/counter/i);
		const lower = await run(
			await assertion(key.kp, { counter: 4 }),
			credential,
		);
		expect(lower.ok).toBe(false);
		expect(
			await run(await assertion(key.kp, { counter: 6 }), credential),
		).toEqual({
			ok: true,
			newCounter: 6,
		});
	});

	it("rejects a well-formed signature by a different key (wrong key)", async () => {
		const { credential } = await stored(0);
		const other = await newKey();
		const result = await run(await assertion(other.kp), credential);
		expect(result).toMatchObject({ ok: false, reason: "verification_failed" });
		if (!result.ok) expect(result.detail).toMatch(/signature/i);
	});

	it("rejects authenticator data changed after signing", async () => {
		const { key, credential } = await stored(0);
		const result = await run(
			await assertion(
				key.kp,
				{},
				{ authData: (a) => cat(a.slice(0, 33), u32(9)) },
			),
			credential,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.detail).toMatch(/signature/i);
	});

	it("rejects client data changed after signing", async () => {
		const { key, credential } = await stored(0);
		const result = await run(
			await assertion(
				key.kp,
				{},
				{
					clientData: (c) =>
						te.encode(
							new TextDecoder()
								.decode(c)
								.replace('"crossOrigin":false', '"crossOrigin":false '),
						),
				},
			),
			credential,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.detail).toMatch(/signature/i);
	});

	const signedBad: [string, Opts, RegExp][] = [
		["wrong challenge", { challenge: "other" }, /challenge/i],
		["wrong origin", { origin: "https://evil.example.com" }, /origin/i],
		["wrong rp id hash", { rpId: "evil.example.com" }, /rp id|rpid/i],
		["wrong client data type", { type: "webauthn.create" }, /type/i],
		["no user verification", { uv: false }, /verif/i],
	];
	for (const [name, opts, detail] of signedBad) {
		it(`rejects a correctly signed assertion with ${name}`, async () => {
			const { key, credential } = await stored(0);
			const result = await run(await assertion(key.kp, opts), credential);
			expect(result).toMatchObject({
				ok: false,
				reason: "verification_failed",
			});
			if (!result.ok) expect(result.detail).toMatch(detail);
		});
	}

	it("rejects a credential id that is not the stored one", async () => {
		const { key, credential } = await stored(0);
		const result = await run(
			await assertion(key.kp, {}, { id: "AAAA" }),
			credential,
		);
		expect(result).toMatchObject({ ok: false, reason: "wrong_credential" });
	});

	it("binds the user handle when one is stored", async () => {
		const { key, credential } = await stored(0);
		const good = await assertion(key.kp, {}, { userHandle: "handle1" });
		expect(
			await run(good, credential, { expectedUserHandle: "handle1" }),
		).toMatchObject({ ok: true });
		const wrong = await assertion(key.kp, {}, { userHandle: "handle2" });
		expect(
			await run(wrong, credential, { expectedUserHandle: "handle1" }),
		).toMatchObject({
			ok: false,
			reason: "wrong_user_handle",
		});
		const missing = await assertion(key.kp);
		expect(
			await run(missing, credential, { expectedUserHandle: "handle1" }),
		).toMatchObject({
			ok: false,
			reason: "wrong_user_handle",
		});
	});
});
