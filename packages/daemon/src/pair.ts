import os from "node:os";
import type { RunDaemonOptions } from "./cli.js";
import { saveDaemonConfig } from "./config.js";

export const PAIRING_TOKEN_PREFIX = "cadmus_pt_";

export interface DecodedPairingToken {
	v: 1;
	accountId: string;
	envId: string;
	url: string;
	wsUrl: string;
	persist: boolean;
	confine: boolean;
	nonce: string;
	exp: number;
	secret: string;
}

export function parsePairingToken(token: string): DecodedPairingToken {
	const trimmed = token.trim();
	if (!trimmed.startsWith(PAIRING_TOKEN_PREFIX)) {
		throw new Error(
			`Invalid pairing token: must start with '${PAIRING_TOKEN_PREFIX}'`,
		);
	}
	const base64url = trimmed.slice(PAIRING_TOKEN_PREFIX.length);
	try {
		const json = Buffer.from(base64url, "base64url").toString("utf-8");
		const payload = JSON.parse(json) as Partial<DecodedPairingToken>;
		if (
			payload.v !== 1 ||
			!payload.accountId ||
			!payload.envId ||
			!payload.url ||
			!payload.wsUrl ||
			typeof payload.persist !== "boolean" ||
			typeof payload.confine !== "boolean" ||
			!payload.nonce ||
			typeof payload.exp !== "number" ||
			!payload.secret
		) {
			throw new Error("Missing required fields in pairing token payload");
		}
		return payload as DecodedPairingToken;
	} catch (err) {
		throw new Error(
			`Failed to decode pairing token: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

export async function performPairing(input: {
	pairingToken: string;
	name?: string;
	workspacePath: string;
	customConfigPath?: string;
	fetchImpl?: typeof fetch;
}): Promise<RunDaemonOptions> {
	const payload = parsePairingToken(input.pairingToken);
	const now = Date.now();
	if (now >= payload.exp) {
		throw new Error(
			"Pairing token has expired (15-minute time limit exceeded). Please generate a fresh token in Cadmus.",
		);
	}

	const daemonName = input.name?.trim() || os.hostname() || "Daemon";
	const pairUrl = new URL("/tools-env/pair", payload.url).toString();
	const fetcher = input.fetchImpl ?? fetch;

	let response: Response;
	try {
		response = await fetcher(pairUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				pairingToken: input.pairingToken.trim(),
				name: daemonName,
			}),
		});
	} catch (err) {
		throw new Error(
			`Failed to connect to Cadmus backend at ${pairUrl}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	if (!response.ok) {
		let message = `Pairing failed with status ${response.status}`;
		try {
			const errJson = (await response.json()) as {
				error?: { code?: string; message?: string };
			};
			if (errJson.error?.message) {
				message = errJson.error.message;
			}
		} catch {
			// ignore json parse error
		}
		throw new Error(message);
	}

	const result = (await response.json()) as {
		ok: boolean;
		token: string;
		envId: string;
		url: string;
		wsUrl: string;
		persist: boolean;
		confineToWorkspace: boolean;
		name?: string;
	};

	if (!result.token) {
		throw new Error(
			"Invalid pairing response: no authentication token received",
		);
	}

	const { configPath, storageMethod } = await saveDaemonConfig(
		{
			url: result.wsUrl || payload.wsUrl,
			envId: result.envId || payload.envId,
			persist: result.persist ?? payload.persist,
			confineToWorkspace: result.confineToWorkspace ?? payload.confine,
			name: result.name || daemonName,
			token: result.token,
		},
		input.customConfigPath,
	);

	console.log(
		`\x1b[32m✔ Successfully paired as "${result.name || daemonName}"!\x1b[0m`,
	);
	console.log(
		`Saved configuration to ${configPath} (token stored in ${storageMethod}).`,
	);

	return {
		url: result.wsUrl || payload.wsUrl,
		token: result.token,
		envId: result.envId || payload.envId,
		workspacePath: input.workspacePath,
		persist: result.persist ?? payload.persist,
		confineToWorkspace: result.confineToWorkspace ?? payload.confine,
	};
}
