/**
 * Browser side of the passkey ceremonies. The server issues WebAuthn JSON
 * options (auth.passkeys.begin) and verifies the browser's JSON answer
 * (auth.passkeys.finish). The browser's own JSON helpers do the encoding, so
 * there is no hand-written base64url code here. A browser without them cannot
 * run a ceremony, and the helper says so instead of guessing.
 */
import type { CadmusClient } from "@cadmus/contract/client";

export type PasskeyPurpose = "register" | "elevate" | "remove";

export type CeremonyResult =
	| { ok: true; result: Record<string, unknown> }
	| {
			ok: false;
			message: string;
			stage: "browser" | "server" | "network";
			/** Finish was sent and the reply was lost: the server may have committed. */
			uncertain?: boolean;
	  };

interface Parsers {
	parseCreationOptionsFromJSON?: (
		o: unknown,
	) => PublicKeyCredentialCreationOptions;
	parseRequestOptionsFromJSON?: (
		o: unknown,
	) => PublicKeyCredentialRequestOptions;
}

export function passkeysSupported(): boolean {
	if (typeof window === "undefined" || !("PublicKeyCredential" in window)) {
		return false;
	}
	const p = window.PublicKeyCredential as unknown as Parsers | undefined;
	if (!p) return false;
	return (
		typeof p.parseCreationOptionsFromJSON === "function" &&
		typeof p.parseRequestOptionsFromJSON === "function"
	);
}

const UNCERTAIN =
	"Could not confirm the result. The change may have gone through. Check the list below before trying again.";

const UNREACHABLE =
	"Could not reach the server. Check your connection and try again.";

/**
 * The client throws when the response is not JSON (a dropped connection can
 * end in a plain-text body). Turn that into a refusal the page can show, so a
 * ceremony never leaves the page stuck. It does not retry.
 */
async function safeRpc<T>(
	client: Pick<CadmusClient, "callRpc">,
	type: string,
	payload: Record<string, unknown>,
): Promise<
	| { ok: true; result?: T }
	| { ok: false; unreachable: boolean; message?: string }
> {
	try {
		const res = await client.callRpc<T>(type, payload);
		if (res.ok) return { ok: true, result: res.result };
		return { ok: false, unreachable: false, message: res.error?.message };
	} catch {
		return { ok: false, unreachable: true };
	}
}

export async function runPasskeyCeremony(
	client: Pick<CadmusClient, "callRpc">,
	purpose: PasskeyPurpose,
	methodId?: string,
): Promise<CeremonyResult> {
	if (!passkeysSupported()) {
		return {
			ok: false,
			message: "This browser cannot use passkeys. Try a current browser.",
			stage: "browser",
		};
	}
	const begun = await safeRpc<{
		challengeId: string;
		options: Record<string, unknown>;
	}>(client, "auth.passkeys.begin", {
		purpose,
		...(methodId ? { methodId } : {}),
	});
	if (!begun.ok) {
		return begun.unreachable
			? { ok: false, message: UNREACHABLE, stage: "network" }
			: {
					ok: false,
					message: begun.message ?? "Passkey request refused",
					stage: "server",
				};
	}
	if (!begun.result) {
		return { ok: false, message: "Passkey request refused", stage: "server" };
	}
	const { challengeId, options } = begun.result;
	const parsers = window.PublicKeyCredential as unknown as Parsers;
	let json: unknown;
	try {
		if (purpose === "register") {
			const publicKey = parsers.parseCreationOptionsFromJSON?.(options);
			const made = (await navigator.credentials.create({
				publicKey,
			})) as (Credential & { toJSON(): unknown }) | null;
			json = made?.toJSON();
		} else {
			const publicKey = parsers.parseRequestOptionsFromJSON?.(options);
			const got = (await navigator.credentials.get({
				publicKey,
			})) as (Credential & { toJSON(): unknown }) | null;
			json = got?.toJSON();
		}
	} catch (err) {
		const name = err instanceof DOMException ? err.name : "";
		return {
			ok: false,
			stage: "browser",
			message:
				name === "InvalidStateError"
					? "This device already holds a passkey for this account. Use a different device or security key."
					: "The passkey prompt was cancelled or failed",
		};
	}
	if (!json || typeof json !== "object") {
		return {
			ok: false,
			stage: "browser",
			message: "The passkey prompt returned nothing",
		};
	}
	const done = await safeRpc<Record<string, unknown>>(
		client,
		"auth.passkeys.finish",
		{ purpose, challengeId, response: json as Record<string, unknown> },
	);
	if (!done.ok) {
		return done.unreachable
			? { ok: false, stage: "network", message: UNCERTAIN, uncertain: true }
			: {
					ok: false,
					stage: "server",
					message: done.message ?? "Passkey refused",
				};
	}
	return { ok: true, result: done.result ?? {} };
}
