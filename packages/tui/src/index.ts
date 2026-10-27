import { createInterface } from "node:readline";
import type {
	AccountModelsListResult,
	ChatStatusRecord,
	ServerEvent,
	ToolsEnvSetting,
	TurnBlock,
} from "@cadmus/contract/types";
import { CadmusProtocolClient } from "./client.js";
import {
	ANSI,
	createTuiState,
	handleServerEvent,
	handleTurnSubmitResult,
	type TuiOutput,
} from "./handler.js";

function writeLine(text = ""): void {
	process.stdout.write(`${text}\n`);
}

const out: TuiOutput = {
	write: (text: string) => process.stdout.write(text),
	writeLine,
};

function toolsEnvFromParts(
	choice: string | undefined,
	envId: string | undefined,
): ToolsEnvSetting | undefined {
	if (choice === "inherit") return null;
	if (choice === "off") {
		return envId ? { enabled: false, binding: { envId } } : { enabled: false };
	}
	if (choice === "on") {
		return envId ? { enabled: true, binding: { envId } } : { enabled: true };
	}
	return undefined;
}

function formatStatusToolsEnv(
	toolsEnv: NonNullable<ChatStatusRecord["toolsEnv"]>,
): string {
	const bits = [
		`toolsEnv enabled=${String(toolsEnv.enabled)}`,
		`enabledSource=${toolsEnv.enabledSource}`,
	];
	if (toolsEnv.kind) bits.push(`kind=${toolsEnv.kind}`);
	if (toolsEnv.envId) bits.push(`envId=${toolsEnv.envId}`);
	if (toolsEnv.bindingSource)
		bits.push(`bindingSource=${toolsEnv.bindingSource}`);
	if (toolsEnv.status) bits.push(`status=${toolsEnv.status}`);
	if (toolsEnv.connectedAt !== undefined) {
		bits.push(`connectedAt=${String(toolsEnv.connectedAt)}`);
	}
	if (toolsEnv.lastError) bits.push(`lastError=${toolsEnv.lastError}`);
	return bits.join(" ");
}

function parseCliArgs(argv: string[]) {
	let url = process.env.CADMUS_URL ?? "http://localhost:8787";
	let token = process.env.CADMUS_TOKEN ?? "dev-cadmus-secret";
	let accountId = process.env.CADMUS_ACCOUNT_ID ?? "default-account";
	let familyId = process.env.CADMUS_FAMILY_ID ?? "default";

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = argv[i + 1];
		if (arg === "--url" && next) {
			url = next;
			i++;
		} else if (arg === "--token" && next) {
			token = next;
			i++;
		} else if (arg === "--account" && next) {
			accountId = next;
			i++;
		} else if (arg === "--family" && next) {
			familyId = next;
			i++;
		}
	}
	return { url, token, accountId, familyId };
}

async function main() {
	const args = parseCliArgs(process.argv.slice(2));
	const tuiState = createTuiState();

	const client = new CadmusProtocolClient({
		baseUrl: args.url,
		token: args.token,
		accountId: args.accountId,
		familyId: args.familyId,
		onEvent: (event: ServerEvent) => {
			handleServerEvent(event, tuiState, out);
		},
	});

	writeLine(
		`${ANSI.bold}${ANSI.cyan}Cadmus Protocol TUI${ANSI.reset} (${args.url}, account=${args.accountId}, family=${args.familyId})`,
	);
	await client.connectWebSocket();
	writeLine(
		`Type ${ANSI.bold}:help${ANSI.reset} for protocol commands, or type any message to send to the active chat.\n`,
	);

	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	const promptUser = () => {
		const label = tuiState.activeChatKey
			? `[${tuiState.activeChatKey}]`
			: "[no-chat]";
		rl.setPrompt(`${ANSI.cyan}cadmus ${label}>${ANSI.reset} `);
		rl.prompt();
	};

	rl.on("line", async (line) => {
		const trimmed = line.trim();
		if (!trimmed) {
			promptUser();
			return;
		}

		if (trimmed.startsWith(":")) {
			await handleMetaCommand(trimmed);
			promptUser();
			return;
		}

		if (!tuiState.activeChatKey) {
			writeLine(
				`${ANSI.red}No active chat selected.${ANSI.reset} Create or select one first with ${ANSI.bold}:chat new <botId>${ANSI.reset} or ${ANSI.bold}:use <chatKey>${ANSI.reset}`,
			);
			promptUser();
			return;
		}

		tuiState.streamingDelta = false;
		tuiState.hasStreamedReply = false;
		tuiState.turnBlocks = [];
		const res = await client.sendCommand<{
			reply?: string;
			text?: string;
			outOfBand?: boolean;
			blocks?: TurnBlock[];
		}>("turn.submit", {
			chatKey: tuiState.activeChatKey,
			text: trimmed,
		});

		handleTurnSubmitResult(res, tuiState, out);
		promptUser();
	});

	async function handleMetaCommand(input: string) {
		const parts = input.slice(1).trim().split(/\s+/);
		const cmd = parts[0];

		switch (cmd) {
			case "help": {
				writeLine(`
${ANSI.bold}Meta Commands:${ANSI.reset}
  :bots                                 List bots in current family
  :bot new <slug> <name> [model]        Create a new bot (default model: faux/echo)
  :bot tools-env <botId> <inherit|on|off> [envId]
  :models [provider]                    List supported models and auth status
  :chats [botId]                        List chats
  :chat new <botId> [title]             Create a new chat and set it active
  :chat tools-env <inherit|on|off> [envId]
  :use <chatKey>                        Switch active chat
  :files <botId>                        List virtual files for a bot
  :read <botId> <path>                  Read SOUL.md, MEMORY.md, or knowledge/<slug>.md
  :schedules [botId]                    List schedules
  :cred set <provider> <apiKey>         Store encrypted BYOK API key on account
  :cred list                            List stored account credentials
  :cred providers                       List available OAuth providers
  :cred login <provider>                Start OAuth flow (e.g. :cred login xai)
  :cred status <flowId>                 Check status of an OAuth flow
  :cred cancel <flowId>                 Cancel an in-flight OAuth flow
  :status                               Run out-of-band /status on active chat
  :quit                                 Exit TUI
`);
				break;
			}

			case "models": {
				const provider = parts[1];
				const res = await client.sendCommand<AccountModelsListResult>(
					"account.models.list",
					{
						...(provider ? { provider } : {}),
					},
				);
				if (!res.ok || !res.result?.models) {
					writeLine(JSON.stringify(res.error, null, 2));
					break;
				}
				const models = res.result.models;
				if (models.length === 0) {
					writeLine(
						`No models found${provider ? ` for provider "${provider}"` : ""}.`,
					);
					break;
				}
				writeLine(
					`\n${ANSI.bold}Supported Models (${models.length}):${ANSI.reset}`,
				);
				for (const m of models) {
					const modelRef = `${m.provider}/${m.id}`;
					const authBadge = m.authenticated
						? `${ANSI.green}[✓ configured]${ANSI.reset}`
						: `${ANSI.dim}[  no key]${ANSI.reset}     `;
					const details = [
						m.contextWindow
							? `ctx: ${Math.round(m.contextWindow / 1000)}k`
							: "",
						m.maxTokens ? `max: ${Math.round(m.maxTokens / 1000)}k` : "",
						m.thinkingLevels && m.thinkingLevels.length > 0
							? `thinking: [${m.thinkingLevels.join(",")}]`
							: m.reasoning
								? "thinking"
								: "",
					]
						.filter(Boolean)
						.join(", ");
					const detailStr = details
						? ` ${ANSI.dim}(${details})${ANSI.reset}`
						: "";
					writeLine(
						`  ${authBadge} ${ANSI.bold}${modelRef.padEnd(45)}${ANSI.reset} ${m.name}${detailStr}`,
					);
				}
				writeLine();
				break;
			}

			case "bots": {
				const res = await client.sendCommand<{ bots: unknown[] }>(
					"bot.list",
					{},
				);
				writeLine(JSON.stringify(res.result ?? res.error, null, 2));
				break;
			}

			case "bot": {
				if (parts[1] === "new" && parts[2] && parts[3]) {
					const slug = parts[2];
					const name = parts[3];
					const model = parts[4] ?? "faux/echo";
					const res = await client.sendCommand("bot.create", {
						slug,
						name,
						model,
					});
					writeLine(JSON.stringify(res.result ?? res.error, null, 2));
				} else if (parts[1] === "tools-env" && parts[2] && parts[3]) {
					const toolsEnv = toolsEnvFromParts(parts[3], parts[4]);
					if (toolsEnv === undefined) {
						writeLine("Usage: :bot tools-env <botId> <inherit|on|off> [envId]");
						break;
					}
					const res = await client.sendCommand("bot.update", {
						botId: parts[2],
						toolsEnv,
					});
					writeLine(JSON.stringify(res.result ?? res.error, null, 2));
				} else {
					writeLine(
						"Usage:\n  :bot new <slug> <name> [model]\n  :bot tools-env <botId> <inherit|on|off> [envId]",
					);
				}
				break;
			}

			case "chats": {
				const res = await client.sendCommand("chat.list", {
					...(parts[1] ? { botId: parts[1] } : {}),
				});
				writeLine(JSON.stringify(res.result ?? res.error, null, 2));
				break;
			}

			case "chat": {
				if (parts[1] === "new" && parts[2]) {
					const botId = parts[2];
					const title = parts.slice(3).join(" ") || undefined;
					const res = await client.sendCommand<{ chat: { key: string } }>(
						"chat.create",
						{ botId, ...(title ? { title } : {}) },
					);
					if (res.ok && res.result?.chat?.key) {
						tuiState.activeChatKey = res.result.chat.key;
						writeLine(
							`Created and switched to chat: ${tuiState.activeChatKey}`,
						);
					} else {
						writeLine(JSON.stringify(res.error, null, 2));
					}
				} else if (parts[1] === "tools-env" && parts[2]) {
					if (!tuiState.activeChatKey) {
						writeLine("Select a chat first with :use <chatKey>");
						break;
					}
					const toolsEnv = toolsEnvFromParts(parts[2], parts[3]);
					if (toolsEnv === undefined) {
						writeLine("Usage: :chat tools-env <inherit|on|off> [envId]");
						break;
					}
					const res = await client.sendCommand("chat.update", {
						chatKey: tuiState.activeChatKey,
						toolsEnv,
					});
					writeLine(JSON.stringify(res.result ?? res.error, null, 2));
				} else {
					writeLine(
						"Usage:\n  :chat new <botId> [title]\n  :chat tools-env <inherit|on|off> [envId]",
					);
				}
				break;
			}

			case "use": {
				if (parts[1]) {
					tuiState.activeChatKey = parts[1];
					writeLine(`Active chat set to: ${tuiState.activeChatKey}`);
				} else {
					writeLine("Usage: :use <chatKey>");
				}
				break;
			}

			case "files": {
				if (!parts[1]) {
					writeLine("Usage: :files <botId>");
					break;
				}
				const res = await client.sendCommand("file.list", { botId: parts[1] });
				writeLine(JSON.stringify(res.result ?? res.error, null, 2));
				break;
			}

			case "read": {
				if (!parts[1] || !parts[2]) {
					writeLine("Usage: :read <botId> <path>");
					break;
				}
				const res = await client.sendCommand("file.read", {
					botId: parts[1],
					path: parts[2],
				});
				writeLine(JSON.stringify(res.result ?? res.error, null, 2));
				break;
			}

			case "schedules": {
				const res = await client.sendCommand("schedule.list", {
					...(parts[1] ? { botId: parts[1] } : {}),
				});
				writeLine(JSON.stringify(res.result ?? res.error, null, 2));
				break;
			}

			case "cred": {
				const sub = parts[1];
				if (sub === "set" && parts[2] && parts[3]) {
					const res = await client.sendCommand("account.credentials.set", {
						providerId: parts[2],
						credential: { type: "api_key", apiKey: parts[3] },
					});
					writeLine(JSON.stringify(res.result ?? res.error, null, 2));
				} else if (sub === "list") {
					const res = await client.sendCommand("account.credentials.list", {});
					writeLine(JSON.stringify(res.result ?? res.error, null, 2));
				} else if (sub === "providers") {
					const res = await client.sendCommand<{ providers: unknown[] }>(
						"account.oauth.providers",
						{},
					);
					writeLine(JSON.stringify(res.result ?? res.error, null, 2));
				} else if (sub === "login" && parts[2]) {
					const providerId = parts[2];
					writeLine(`Starting OAuth login for "${providerId}"...`);
					const res = await client.sendCommand<{
						flow: Record<string, unknown>;
					}>("account.oauth.start", { providerId });
					if (res.ok && res.result?.flow) {
						const flow = res.result.flow;
						writeLine(
							`Flow ID: ${String(flow.flowId)} (status: ${String(flow.status)})`,
						);
						if (flow.verificationUri || flow.userCode) {
							writeLine(
								`\n${ANSI.bold}Please verify in your browser:${ANSI.reset}`,
							);
							if (flow.verificationUriComplete) {
								writeLine(
									`URL:  ${ANSI.cyan}${String(flow.verificationUriComplete)}${ANSI.reset}`,
								);
							} else if (flow.verificationUri) {
								writeLine(
									`URL:  ${ANSI.cyan}${String(flow.verificationUri)}${ANSI.reset}`,
								);
							}
							if (flow.userCode) {
								writeLine(
									`Code: ${ANSI.bold}${ANSI.yellow}${String(flow.userCode)}${ANSI.reset}`,
								);
							}
							writeLine("\nWaiting for authorization in the background...");
						} else if (flow.authorizationUrl) {
							writeLine(
								`\n${ANSI.bold}Sign-in URL:${ANSI.reset} ${ANSI.cyan}${String(flow.authorizationUrl)}${ANSI.reset}`,
							);
						}
						if (flow.message) {
							writeLine(String(flow.message));
						}
					} else {
						writeLine(JSON.stringify(res.error, null, 2));
					}
				} else if (sub === "status" && parts[2]) {
					const res = await client.sendCommand("account.oauth.status", {
						flowId: parts[2],
					});
					writeLine(JSON.stringify(res.result ?? res.error, null, 2));
				} else if (sub === "cancel" && parts[2]) {
					const res = await client.sendCommand("account.oauth.cancel", {
						flowId: parts[2],
					});
					writeLine(JSON.stringify(res.result ?? res.error, null, 2));
				} else if (sub === "submit" && parts[2] && parts[3]) {
					const res = await client.sendCommand("account.oauth.submit", {
						flowId: parts[2],
						input: parts.slice(3).join(" "),
					});
					writeLine(JSON.stringify(res.result ?? res.error, null, 2));
				} else {
					writeLine(
						"Usage:\n  :cred set <provider> <apiKey>\n  :cred list\n  :cred providers\n  :cred login <provider>\n  :cred status <flowId>\n  :cred cancel <flowId>\n  :cred submit <flowId> <input>",
					);
				}
				break;
			}

			case "status": {
				if (!tuiState.activeChatKey) {
					writeLine("Select a chat first with :use <chatKey>");
					break;
				}
				const res = await client.sendCommand<{
					text?: string;
					status?: ChatStatusRecord;
				}>("turn.command", {
					chatKey: tuiState.activeChatKey,
					command: "/status",
				});
				if (res.ok && res.result?.text) {
					writeLine(`\n${res.result.text}\n`);
					const toolsEnv = res.result.status?.toolsEnv;
					if (toolsEnv) {
						writeLine(formatStatusToolsEnv(toolsEnv));
					}
				} else {
					writeLine(JSON.stringify(res.result ?? res.error, null, 2));
				}
				break;
			}

			case "quit":
			case "exit": {
				client.close();
				rl.close();
				process.exit(0);
				break;
			}

			default:
				writeLine(`Unknown command :${cmd}. Type :help for usage.`);
		}
	}

	promptUser();
}

void main();
