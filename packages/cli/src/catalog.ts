/**
 * Runtime view of the protocol. Names come from `API_ROUTES`. Descriptions
 * and payload fields come from the contract command schemas. Nothing here
 * lists commands by hand.
 */
import { API_ROUTES, type ApiCommandName } from "@cadmus/contract/routes";
import { commandCatalog, ServerEventSchema } from "@cadmus/contract/schemas";
import { defaultOrigin } from "./origin.js";

export interface PayloadField {
	name: string;
	type: string;
	required: boolean;
	description: string;
}

export interface CommandInfo {
	name: string;
	method: "GET" | "POST";
	readOnly: boolean;
	description: string;
	fields: PayloadField[];
}

export interface EventInfo {
	type: string;
	description: string;
}

interface JsonSchema {
	description?: string;
	type?: string;
	const?: string;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	anyOf?: JsonSchema[];
	oneOf?: JsonSchema[];
	items?: JsonSchema;
}

const catalog = commandCatalog as unknown as Record<
	string,
	{ command: JsonSchema }
>;

export function listCommands(): CommandInfo[] {
	return (Object.keys(API_ROUTES) as ApiCommandName[]).map((name) =>
		commandInfo(name),
	);
}

export function commandInfo(name: string): CommandInfo {
	const route = API_ROUTES[name as ApiCommandName];
	if (!route) {
		throw new Error(`unknown command ${name}`);
	}
	const schema = catalog[name]?.command;
	return {
		name,
		method: route.method,
		readOnly: route.readOnly,
		description: schema?.description ?? "",
		fields: payloadFields(schema),
	};
}

export function listEvents(): EventInfo[] {
	const union = ServerEventSchema as unknown as JsonSchema;
	const variants = union.anyOf ?? union.oneOf ?? [];
	const events: EventInfo[] = [];
	for (const variant of variants) {
		const type = variant.properties?.type?.const;
		if (!type) continue;
		events.push({
			type,
			description:
				variant.description ?? variant.properties?.type?.description ?? "",
		});
	}
	return events;
}

export function isRpcCommand(name: string): boolean {
	return Object.hasOwn(API_ROUTES, name);
}

function payloadFields(schema: JsonSchema | undefined): PayloadField[] {
	const payload = schema?.properties?.payload;
	if (!payload) return [];
	const fields: PayloadField[] = [];
	walk(payload, "", true, fields);
	return fields;
}

function walk(
	schema: JsonSchema,
	prefix: string,
	parentRequired: boolean,
	out: PayloadField[],
): void {
	if (schema.type !== "object" || !schema.properties) return;
	const required = new Set(schema.required ?? []);
	for (const [key, prop] of Object.entries(schema.properties)) {
		const name = prefix.length > 0 ? `${prefix}.${key}` : key;
		const childRequired = parentRequired && required.has(key);
		if (prop.type === "object" && prop.properties) {
			walk(prop, name, childRequired, out);
			continue;
		}
		out.push({
			name,
			type: typeLabel(prop),
			required: childRequired,
			description: describe(prop),
		});
	}
}

function describe(schema: JsonSchema): string {
	if (schema.description) return schema.description;
	const variants = schema.anyOf ?? schema.oneOf ?? [];
	const parts = variants
		.map((variant) => variant.description)
		.filter((item): item is string => Boolean(item));
	return parts.join(" ");
}

function typeLabel(schema: JsonSchema): string {
	const variants = schema.anyOf ?? schema.oneOf;
	if (variants && variants.length > 0) {
		const consts = variants
			.map((variant) => variant.const)
			.filter((item): item is string => typeof item === "string");
		if (consts.length === variants.length) return consts.join(" | ");
		const labels = [...new Set(variants.map((variant) => typeLabel(variant)))];
		return labels.join(" | ");
	}
	if (schema.const) return schema.const;
	if (schema.type === "array") {
		const item = schema.items ? typeLabel(schema.items) : "unknown";
		return `array<${item}>`;
	}
	if (schema.type === "object") return "object";
	return schema.type ?? "unknown";
}

export function renderSkill(): string {
	const commands = listCommands();
	const events = listEvents();
	const catalogLines = commands
		.map((command) => {
			const fields =
				command.fields.length === 0
					? ""
					: `\n${command.fields
							.map(
								(field) =>
									`  - \`${field.name}\` (${field.type}${field.required ? ", required" : ""}): ${field.description}`,
							)
							.join("\n")}`;
			return `### \`${command.name}\`\n\n${command.method} ${command.readOnly ? "read-only" : "mutating"}. ${command.description}${fields}`;
		})
		.join("\n\n");
	const eventLines = events
		.map((event) => `- \`${event.type}\`: ${event.description}`)
		.join("\n");
	return `# cadmus

Stateless command line for the Cadmus protocol. Every RPC is a command. Output is JSON on stdout. \`--pretty\` indents it. Errors are JSON \`{code,message}\` on stderr.

## Auth and targeting

Flags override environment variables.

| Flag | Environment | Meaning |
| :--- | :--- | :--- |
| \`--url\` | \`CADMUS_URL\` | Worker origin. Default \`${defaultOrigin()}\`. Source runs use \`http://localhost:8787\`. The compiled binary uses \`https://cadmus.purelogicstudios.com\`. |
| \`--token\` | \`CADMUS_TOKEN\` | Explicit \`cad_at_\` override. Not written to the keychain. |
| \`--account\` | \`CADMUS_ACCOUNT_ID\` | \`x-account-id\`. |
| \`--family\` | \`CADMUS_FAMILY_ID\` | \`X-Cadmus-Family-Id\` and the \`/ws\` \`familyId\` query. |

\`cadmus login\` stores only the refresh secret (\`cad_rt_\`) in the OS keychain, or in \`~/.config/cadmus/credentials.json\` when the keychain is unavailable. Later commands refresh that secret. \`cadmus logout\` revokes it and deletes the local copy. \`--dev-password\` uses the worker's dev-password login when that provider is offered. \`--device\` prints the URL instead of opening a browser.

## Invoke

\`\`\`text
cadmus login [--device|--dev-password]
cadmus logout
cadmus <command> [json] [--payload @file|-] [--key value]
cadmus <command> --help
cadmus commands
cadmus send <chatKey> <text|-> [--timeout 600] [--stream]
cadmus events [--chat K] [--types a,b]
cadmus --skill
cadmus --version
\`\`\`

The payload is merged lowest priority first: positional JSON, then \`--payload\`, then flags. Flag values parse as JSON when they are valid JSON. Dotted names nest (\`--target.mode chat\`).

Exit codes: 0 ok, 1 protocol or HTTP error, 2 usage, 3 transport or auth, 4 turn failed or timed out.

## Recipes

### Inspect a bot and its files

\`\`\`bash
cadmus bot.create --slug scribe --name Scribe --model faux/echo
cadmus bot.get --botId scribe
cadmus file.list --botId scribe
cadmus file.read --botId scribe --path SOUL.md
\`\`\`

### Send and await a reply

\`\`\`bash
cadmus chat.create --botId scribe --key notes
cadmus send notes "Hello"
cadmus send notes - --stream < message.txt
\`\`\`

\`send\` opens \`/ws\`, runs \`turn.submit\`, and waits for \`turn.completed\` or a failed turn. \`--stream\` prints delta and tool events as NDJSON.

### Read a transcript

\`\`\`bash
cadmus chat.get --chatKey notes
cadmus chat.entries --chatKey notes
cadmus chat.messages --chatKey notes
\`\`\`

### View group chats

Group chats are read-only (\`kind\` \`group\`). Listing and reading them does not post.

\`\`\`bash
cadmus chat.list --kinds group
cadmus chat.get --chatKey <groupKey>
cadmus events --types bot.message --chat <groupKey>
\`\`\`

### Schedules

\`\`\`bash
cadmus schedule.create --id wake --botId scribe --kind absolute --input 0 --text "ping" --target.mode chat --target.chatKey notes
cadmus schedule.list --botId scribe
cadmus schedule.delete --id wake
\`\`\`

### Tools-env pairing

\`\`\`bash
cadmus account.toolsEnvs.create --name laptop --kind local-daemon
cadmus account.toolsEnvs.pair --envId <id>
cadmus account.toolsEnvs.list
cadmus account.toolsEnvs.deregister --envId <id>
\`\`\`

## Commands

${catalogLines}

## Events

${eventLines}
`;
}
