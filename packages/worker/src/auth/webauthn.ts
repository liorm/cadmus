/**
 * WebAuthn verification for `auth.passkeys.begin` and `auth.passkeys.finish`.
 *
 * Verification is delegated to @simplewebauthn/server. This module only fixes
 * the policy the app accepts: ES256 keys, user verification required, no
 * attestation (`fmt: "none"`), and a relying party taken from trusted config,
 * never from the request. It performs no storage. The Family DO command
 * handlers call it.
 */
import {
	type AuthenticationResponseJSON,
	type RegistrationResponseJSON,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { fromBase64Url, toBase64Url } from "../base64url.js";

const COSE_ES256 = -7;

export interface RelyingParty {
	/** Registrable domain, e.g. "cadmus.example.com". */
	id: string;
	/** Exact origin, e.g. "https://cadmus.example.com". */
	origin: string;
}

/**
 * Derive the relying party from the configured public URL. Returns null for an
 * unset or unusable value so callers fail closed. Only https is accepted,
 * except http://localhost for local development.
 */
export function relyingPartyFromUrl(
	url: string | undefined,
): RelyingParty | null {
	if (!url) return null;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	const local = parsed.protocol === "http:" && parsed.hostname === "localhost";
	if (parsed.protocol !== "https:" && !local) return null;
	if (parsed.username || parsed.password) return null;
	// An RP ID must be a domain, not an IP literal (the WebAuthn WG minutes of
	// 2020-02-19 record that the spec does not permit IP addresses). WHATWG URL
	// parsing normalises numeric hosts to dotted IPv4 and brackets IPv6.
	if (
		parsed.hostname.startsWith("[") ||
		/^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname)
	) {
		return null;
	}
	return { id: parsed.hostname, origin: parsed.origin };
}

export type PasskeyFailure =
	| "invalid_response"
	| "wrong_credential"
	| "wrong_user_handle"
	| "unsupported_attestation"
	| "unsupported_algorithm"
	| "verification_failed";

export type PasskeyRegistration =
	| {
			ok: true;
			credentialId: string;
			/** COSE public key, base64url. */
			publicKey: string;
			counter: number;
			transports: string[];
			deviceType: "singleDevice" | "multiDevice";
			backedUp: boolean;
	  }
	| { ok: false; reason: PasskeyFailure; detail: string };

export type PasskeyAuthentication =
	| { ok: true; newCounter: number }
	| { ok: false; reason: PasskeyFailure; detail: string };

const message = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

export async function verifyPasskeyRegistration(input: {
	response: RegistrationResponseJSON;
	expectedChallenge: string;
	rp: RelyingParty;
}): Promise<PasskeyRegistration> {
	let result: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
	try {
		result = await verifyRegistrationResponse({
			response: input.response,
			expectedChallenge: input.expectedChallenge,
			expectedOrigin: input.rp.origin,
			expectedRPID: input.rp.id,
			expectedType: "webauthn.create",
			requireUserPresence: true,
			requireUserVerification: true,
			supportedAlgorithmIDs: [COSE_ES256],
		});
	} catch (error) {
		return { ok: false, reason: "verification_failed", detail: message(error) };
	}
	if (!result.verified || !result.registrationInfo) {
		return { ok: false, reason: "verification_failed", detail: "not verified" };
	}
	const info = result.registrationInfo;
	if (info.fmt !== "none") {
		return { ok: false, reason: "unsupported_attestation", detail: info.fmt };
	}
	if (info.credential.id !== input.response.id) {
		return { ok: false, reason: "wrong_credential", detail: "id mismatch" };
	}
	return {
		ok: true,
		credentialId: info.credential.id,
		publicKey: toBase64Url(info.credential.publicKey),
		counter: info.credential.counter,
		transports: info.credential.transports ?? [],
		deviceType: info.credentialDeviceType,
		backedUp: info.credentialBackedUp,
	};
}

export async function verifyPasskeyAuthentication(input: {
	response: AuthenticationResponseJSON;
	expectedChallenge: string;
	rp: RelyingParty;
	credential: { id: string; publicKey: string; counter: number };
	/**
	 * The stored user handle the response must carry (discoverable sign-in).
	 * Pass null only for a flow that identifies the user by session and
	 * deliberately does not use a handle; omitting it is a type error.
	 */
	expectedUserHandle: string | null;
}): Promise<PasskeyAuthentication> {
	const { response, credential } = input;
	if (response.id !== credential.id || response.rawId !== credential.id) {
		return { ok: false, reason: "wrong_credential", detail: "id mismatch" };
	}
	if (
		input.expectedUserHandle !== null &&
		response.response.userHandle !== input.expectedUserHandle
	) {
		return {
			ok: false,
			reason: "wrong_user_handle",
			detail: "handle mismatch",
		};
	}
	let result: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
	try {
		result = await verifyAuthenticationResponse({
			response,
			expectedChallenge: input.expectedChallenge,
			expectedOrigin: input.rp.origin,
			expectedRPID: input.rp.id,
			expectedType: "webauthn.get",
			requireUserVerification: true,
			credential: {
				id: credential.id,
				publicKey: fromBase64Url(credential.publicKey),
				counter: credential.counter,
			},
		});
	} catch (error) {
		return { ok: false, reason: "verification_failed", detail: message(error) };
	}
	if (!result.verified) {
		return {
			ok: false,
			reason: "verification_failed",
			detail: "signature did not verify",
		};
	}
	return { ok: true, newCounter: result.authenticationInfo.newCounter };
}
