#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { stdin } from "node:process";
import type { CommandResultFrame, ServerEvent } from "@cadmus/contract/types";
import { mergePayload, type ParsedArgv, parseArgv } from "./argv.js";
import {
	commandInfo,
	isRpcCommand,
	listCommands,
	renderSkill,
} from "./catalog.js";
import { createClient } from "./client.js";
import {
	EXIT_OK,
	EXIT_TRANSPORT,
	EXIT_TURN,
	EXIT_USAGE,
	exitForCommandFailure,
} from "./exit-codes.js";
import { ensureAccessToken, runLogin, runLogout } from "./login.js";
import { createDefaultSecretStore } from "./secret-store.js";
import { CLI_VERSION } from "./version.js";

const STREAM_TYPES = new Set([
	"turn.delta",
	"turn.tool_call",
	"turn.tool_result",
	"turn.completed",
]);

interface Connection {
	url: string;
	token: string;
	account?: string;
	family?: string;
	pretty: boolean;
}

async function main(): Promise<number> {
	let parsed: ParsedArgv;
	try {
		parsed = parseArgv(process.argv.slice(2));
	} catch (error) {
		return usage(error instanceof Error ? error.message : String(error), false);
	}
	if (parsed.help && parsed.command === undefined) {
		process.stdout.write(`${globalHelp()}\n`);
		return EXIT_OK;
	}
	if (parsed.version && !parsed.help && parsed.command === undefined) {
		process.stdout.write(`${CLI_VERSION}\n`);
		return EXIT_OK;
	}
	if (parsed.skill && parsed.command === undefined && !parsed.help) {
		process.stdout.write(renderSkill());
		return EXIT_OK;
	}
	if (parsed.command === undefined)
		return usage("missing command", parsed.pretty);
	if (parsed.command === "login") {
		if (parsed.help) {
			return usage("login [--device|--dev-password]", parsed.pretty);
		}
		const connection = resolveConnection(parsed);
		return runLogin({
			origin: connection.url,
			pretty: connection.pretty,
			store: createDefaultSecretStore(),
			device: parsed.device,
			devPassword: parsed.devPassword,
		});
	}
	if (parsed.command === "logout") {
		if (parsed.help) return usage("logout", parsed.pretty);
		const connection = resolveConnection(parsed);
		return runLogout({
			origin: connection.url,
			pretty: connection.pretty,
			store: createDefaultSecretStore(),
		});
	}
	if (parsed.command === "commands") {
		writeJson(
			listCommands().map(({ fields: _fields, ...rest }) => rest),
			parsed.pretty,
		);
		return EXIT_OK;
	}
	if (parsed.help) {
		if (!isRpcCommand(parsed.command)) {
			return usage(`unknown command ${parsed.command}`, parsed.pretty);
		}
		writeJson(commandInfo(parsed.command), parsed.pretty);
		return EXIT_OK;
	}
	const resolved = await resolveAccess(parsed);
	if (typeof resolved === "number") return resolved;
	const connection = resolved;
	if (parsed.command === "send") return runSend(parsed, connection);
	if (parsed.command === "events") return runEvents(parsed, connection);
	if (!isRpcCommand(parsed.command)) {
		return usage(`unknown command ${parsed.command}`, parsed.pretty);
	}
	let payload: Record<string, unknown>;
	try {
		payload = await buildPayload(parsed);
	} catch (error) {
		return usage(
			error instanceof Error ? error.message : String(error),
			parsed.pretty,
		);
	}
	const client = createClient(connection);
	try {
		const frame = await client.callRpc(parsed.command, payload);
		return finishFrame(frame, connection.pretty);
	} catch (error) {
		return transport(error, connection.pretty);
	}
}

function resolveConnection(parsed: ParsedArgv): Connection {
	return {
		url: parsed.url ?? process.env.CADMUS_URL ?? "http://localhost:8787",
		token: parsed.token ?? process.env.CADMUS_TOKEN ?? "",
		account: parsed.account ?? process.env.CADMUS_ACCOUNT_ID,
		family: parsed.family ?? process.env.CADMUS_FAMILY_ID,
		pretty: parsed.pretty,
	};
}

async function resolveAccess(parsed: ParsedArgv): Promise<Connection | number> {
	const connection = resolveConnection(parsed);
	if (connection.token.length > 0) return connection;
	const ensured = await ensureAccessToken({
		origin: connection.url,
		token: "",
		store: createDefaultSecretStore(),
	});
	if ("error" in ensured) {
		return fail(
			EXIT_TRANSPORT,
			"unauthorized",
			ensured.error,
			connection.pretty,
		);
	}
	return { ...connection, token: ensured.token };
}

async function buildPayload(
	parsed: ParsedArgv,
): Promise<Record<string, unknown>> {
	const positional = parsed.positionals[0];
	let payloadText: string | undefined;
	if (parsed.payloadSource === "-") {
		payloadText = await readStdin();
	} else if (parsed.payloadSource?.startsWith("@")) {
		payloadText = readFileSync(parsed.payloadSource.slice(1), "utf8");
	} else if (parsed.payloadSource !== undefined) {
		payloadText = parsed.payloadSource;
	}
	return mergePayload({
		positional,
		payloadText,
		flags: parsed.payloadFlags,
	});
}

async function readStdin(): Promise<string> {
	if (stdin.isTTY) throw new Error("--payload - needs a stdin pipe");
	const chunks: Buffer[] = [];
	for await (const chunk of stdin) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function runSend(
	parsed: ParsedArgv,
	connection: Connection,
): Promise<number> {
	const chatKey = parsed.positionals[0];
	const textArg = parsed.positionals[1];
	if (!chatKey || textArg === undefined) {
		return usage("send requires <chatKey> <text|->", connection.pretty);
	}
	let text = textArg;
	if (textArg === "-") {
		try {
			text = (await readStdin()).replace(/\n$/, "");
		} catch (error) {
			return usage(
				error instanceof Error ? error.message : String(error),
				connection.pretty,
			);
		}
	}
	const timeoutSeconds =
		parsed.timeout === undefined ? 600 : Number(parsed.timeout);
	if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
		return usage(
			"--timeout must be a non-negative number of seconds",
			connection.pretty,
		);
	}
	const client = createClient(connection);
	const events: ServerEvent[] = [];
	try {
		await client.connect({
			onEvent: (event) => {
				if (!eventMatchesChat(event, chatKey)) return;
				events.push(event);
				if (parsed.stream && STREAM_TYPES.has(event.type)) {
					process.stdout.write(`${JSON.stringify(event)}\n`);
				}
			},
		});
	} catch (error) {
		client.close();
		return transport(error, connection.pretty);
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const submitted = client.sendOverSocket<Record<string, unknown>>(
		"turn.submit",
		{ chatKey, text },
	);
	submitted.catch(() => {});
	try {
		const frame = await Promise.race([
			submitted,
			new Promise<CommandResultFrame<Record<string, unknown>>>(
				(_resolve, reject) => {
					timer = setTimeout(
						() => reject(new Error(`timed out after ${timeoutSeconds}s`)),
						timeoutSeconds * 1000,
					);
				},
			),
		]);
		if (timer) clearTimeout(timer);
		const failed = events.find(
			(event) => (event as { type: string }).type === "turn.failed",
		);
		if (!frame.ok || failed) {
			const message = frame.error?.message ?? "turn failed";
			const code = frame.error?.code ?? "turn_failed";
			return fail(EXIT_TURN, code, message, connection.pretty);
		}
		// Events are delivered after a live authority check, so they can land
		// just after the command result. Keep the socket open until the turn
		// event arrives when the caller asked to stream.
		if (parsed.stream) {
			const deadline = Date.now() + Math.min(timeoutSeconds, 5) * 1000;
			while (
				Date.now() < deadline &&
				!events.some(
					(event) =>
						event.type === "turn.completed" ||
						(event as { type: string }).type === "turn.failed",
				)
			) {
				await new Promise((resolve) => setTimeout(resolve, 15));
			}
		}
		writeJson(frame.result ?? null, connection.pretty);
		return EXIT_OK;
	} catch (error) {
		if (timer) clearTimeout(timer);
		const message = error instanceof Error ? error.message : String(error);
		if (message.startsWith("timed out")) {
			return fail(EXIT_TURN, "timeout", message, connection.pretty);
		}
		return transport(error, connection.pretty);
	} finally {
		client.close();
	}
}

async function runEvents(
	parsed: ParsedArgv,
	connection: Connection,
): Promise<number> {
	const types = new Set(
		(parsed.types ?? "")
			.split(",")
			.map((item) => item.trim())
			.filter((item) => item.length > 0),
	);
	const client = createClient(connection);
	let stop: (() => void) | undefined;
	const stopped = new Promise<void>((resolve) => {
		stop = resolve;
	});
	const onSigint = (): void => stop?.();
	process.on("SIGINT", onSigint);
	try {
		await client.connect({
			onEvent: (event) => {
				if (types.size > 0 && !types.has(event.type)) return;
				if (parsed.chat && !eventMatchesChat(event, parsed.chat)) return;
				process.stdout.write(`${JSON.stringify(event)}\n`);
			},
			onClose: () => stop?.(),
		});
		await stopped;
		return EXIT_OK;
	} catch (error) {
		return transport(error, connection.pretty);
	} finally {
		process.off("SIGINT", onSigint);
		client.close();
	}
}

function eventMatchesChat(event: ServerEvent, chat: string): boolean {
	const payload = (
		event as { payload?: { chatKey?: string; groupChatKey?: string } }
	).payload;
	if (!payload) return false;
	return payload.chatKey === chat || payload.groupChatKey === chat;
}

function finishFrame(frame: CommandResultFrame, pretty: boolean): number {
	if (!frame.ok) {
		const code = frame.error?.code ?? "command_failed";
		const message = frame.error?.message ?? "command failed";
		return fail(exitForCommandFailure(undefined, code), code, message, pretty);
	}
	writeJson(frame.result ?? null, pretty);
	return EXIT_OK;
}

function transport(error: unknown, pretty: boolean): number {
	const message = error instanceof Error ? error.message : String(error);
	return fail(EXIT_TRANSPORT, "transport", message, pretty);
}

function usage(message: string, pretty: boolean): number {
	return fail(EXIT_USAGE, "usage", message, pretty);
}

function fail(
	status: number,
	code: string,
	message: string,
	pretty: boolean,
): number {
	const body = JSON.stringify({ code, message }, null, pretty ? 2 : undefined);
	process.stderr.write(`${body}\n`);
	return status;
}

function writeJson(value: unknown, pretty: boolean): void {
	process.stdout.write(
		`${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`,
	);
}

function globalHelp(): string {
	return JSON.stringify(
		{
			usage: "cadmus <command> [json] [--payload @file|-] [--key value]",
			verbs: ["login", "logout", "send", "events", "commands"],
			flags: [
				"--url",
				"--token",
				"--account",
				"--family",
				"--pretty",
				"--help",
				"--version",
				"--skill",
			],
			version: CLI_VERSION,
		},
		null,
		2,
	);
}

const code = await main();
process.exit(code);
