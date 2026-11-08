import os from "node:os";
import type { RunDaemonOptions } from "./cli.js";
import { saveDaemonConfig } from "./config.js";
import {
	type ConfineDetector,
	detectConfineMechanisms,
	startupDecision,
} from "./confine.js";
import { type DaemonLogger, getDaemonLogger } from "./log.js";

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
	logger?: DaemonLogger;
	detector?: ConfineDetector;
	url?: string;
	persist?: boolean;
	confineToWorkspace?: boolean;
}): Promise<RunDaemonOptions> {
	const logger = input.logger ?? getDaemonLogger();
	const payload = parsePairingToken(input.pairingToken);
	const now = Date.now();
	if (now >= payload.exp) {
		throw new Error(
			"Pairing token has expired (15-minute time limit exceeded). Please generate a fresh token in Cadmus.",
		);
	}

	// The pair endpoint consumes the one-shot token. Refuse a confined daemon
	// that cannot start before that redeem, so a missing bwrap does not burn it.
	if (payload.confine) {
		const decision = startupDecision({
			confineToWorkspace: true,
			detector: input.detector ?? detectConfineMechanisms(),
		});
		if (!decision.start) throw new Error(decision.reason);
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
		const statusLabel = response.statusText
			? `${response.status} ${response.statusText}`
			: String(response.status);
		let detail = "";
		const body = await response.text().catch(() => "");
		if (body) {
			try {
				const errJson = JSON.parse(body) as {
					error?: { code?: string; message?: string };
				};
				if (errJson.error?.message) {
					detail = errJson.error.code
						? `${errJson.error.code}: ${errJson.error.message}`
						: errJson.error.message;
				}
			} catch {
				detail = body.replace(/\s+/g, " ").trim().slice(0, 200);
			}
		}
		const message = detail
			? `Pairing failed with status ${statusLabel} at ${pairUrl}: ${detail}`
			: `Pairing failed with status ${statusLabel} at ${pairUrl}`;
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

	const finalName = input.name || result.name || daemonName;
	const finalUrl = input.url || result.wsUrl || payload.wsUrl;
	const finalPersist = input.persist ?? result.persist ?? payload.persist;
	const finalConfine =
		input.confineToWorkspace ?? result.confineToWorkspace ?? payload.confine;

	const { configPath, storageMethod } = await saveDaemonConfig(
		{
			url: finalUrl,
			envId: result.envId || payload.envId,
			persist: finalPersist,
			confineToWorkspace: finalConfine,
			name: finalName,
			token: result.token,
		},
		input.customConfigPath,
	);

	logger.info("daemon.paired", {
		name: finalName,
		envId: result.envId || payload.envId,
		configPath,
		storageMethod,
	});

	return {
		url: finalUrl,
		token: result.token,
		envId: result.envId || payload.envId,
		workspacePath: input.workspacePath,
		persist: finalPersist,
		confineToWorkspace: finalConfine,
		logger: input.logger,
	};
}
