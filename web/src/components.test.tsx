import { describe, expect, it } from "bun:test";
import { renderToString } from "react-dom/server";
import type {
	BotRecord,
	ChatRecord,
	ChatStatusRecord,
	CommandResultFrame,
	FamilyRecord,
	FileListItem,
	FileReadDocResult,
	HarvestNote,
	RawTranscriptEntry,
	ScheduleRecord,
	ServerEvent,
	TranscriptMessageView,
} from "../../src/protocol.js";
import { App } from "./App.js";
import { CadmusClient, type FetchFunction } from "./client.js";
import { BotDirectory } from "./components/BotDirectory.js";
import { ChatRawView } from "./components/ChatRawView.js";
import { ChatRenderedView } from "./components/ChatRenderedView.js";
import { ChatWorkspace } from "./components/ChatWorkspace.js";
import { FileInspector } from "./components/FileInspector.js";
import {
	HarvestInspector,
	UnifiedDiffViewer,
} from "./components/HarvestInspector.js";
import { SchedulesPanel } from "./components/SchedulesPanel.js";
import { ToolsEnvPinFields } from "./components/ToolsEnvPinFields.js";
import { TopBar } from "./components/TopBar.js";
import { CadmusProvider } from "./context/CadmusContext.js";
import {
	isNearBottom,
	SCROLL_BOTTOM_THRESHOLD,
	useAutoScroll,
} from "./hooks/useAutoScroll.js";
import {
	buildToolsEnvSetting,
	formatToolsEnvSummary,
	hasToolsEnvChanged,
	toolsFormBaseline,
	toolsPayload,
} from "./tools-env-form.js";

const TEST_FAMILY: FamilyRecord = {
	accountId: "acc-test",
	familyId: "fam-test",
	doName: "cadmus:acc-test:fam-test",
	name: "Test Family",
	timezone: "UTC",
	harvestDelayMs: 60000,
	createdAt: 1700000000000,
};

const TEST_BOT: BotRecord = {
	id: "assistant",
	name: "Cadmus Assistant",
	model: "faux/echo",
	thinking: "off",
	tools: ["knowledge_read", "memory_update"],
	timezone: "UTC",
	rootConversationId: 1,
	createdAt: 1700000001000,
};

const TEST_CHAT: ChatRecord = {
	key: "chat-main",
	botId: "assistant",
	conversationId: 1,
	title: "Main Discussion",
	thinking: "off",
	createdAt: 1700000002000,
};

const TEST_FILES: FileListItem[] = [
	{ path: "SOUL.md", kind: "soul", size: 120, version: 1 },
	{ path: "MEMORY.md", kind: "memory", size: 250, version: 3 },
	{
		path: "knowledge/guidelines.md",
		kind: "knowledge",
		size: 450,
		version: 2,
		slug: "guidelines",
		description: "Coding guidelines and rules",
		category: "guides",
	},
];

const TEST_SCHEDULE: ScheduleRecord = {
	id: "sched-hourly-summary",
	botId: "assistant",
	name: "Hourly Summary",
	kind: "cron",
	input: "0 * * * *",
	nextRun: 1700003600000,
	inSeconds: 3600,
	recurring: true,
	text: "Summarize recent activity in the workspace.",
	target: { mode: "new-chat" },
	thinking: "medium",
	enabled: true,
	internal: false,
};

const TEST_HARVEST_SCHEDULE: ScheduleRecord = {
	id: "harvest:chat-main",
	botId: "assistant",
	name: "Idle Harvest Timer",
	kind: "relative",
	input: "60s",
	nextRun: 1700000060000,
	inSeconds: 45,
	recurring: false,
	text: "Extract long-term memory updates from conversation history.",
	target: { mode: "fork", chatKey: "chat-main", at: 5, harvest: true },
	enabled: true,
	internal: true,
};

const TEST_HARVEST_DIFF = `--- a/MEMORY.md
+++ b/MEMORY.md
@@ -1,4 +1,5 @@
 # Memory
 User prefers concise bullet points.
-Needs daily reminders.
+Needs weekly reminders on Mondays.
+Project utilizes Cloudflare Workers and Durable Objects.`;

const TEST_HARVEST_NOTE: HarvestNote = {
	chatKey: "chat-main",
	at: 5,
	when: 1700000060000,
	files: [
		{
			path: "MEMORY.md",
			diff: TEST_HARVEST_DIFF,
		},
		{
			path: "knowledge/architecture.md",
			diff: "--- a/knowledge/architecture.md\n+++ b/knowledge/architecture.md\n@@ -1 +1,2 @@\n# Architecture\n+Uses DO SQLite with Cas CAS mutations.",
		},
	],
};

function createMockClient(
	options: { onRpc?: (type: string, payload: unknown) => unknown } = {},
): CadmusClient {
	const mockFetch: FetchFunction = async (_input, init) => {
		const body = JSON.parse(init?.body as string);
		const type = body.type as string;
		const payload = body.payload;

		if (options.onRpc) {
			const customRes = options.onRpc(type, payload);
			if (customRes !== undefined) {
				const frame: CommandResultFrame = {
					id: body.id,
					type: "command.result",
					command: type,
					ok: true,
					result: customRes,
				};
				return new Response(JSON.stringify(frame));
			}
		}

		let result: unknown = {};
		if (type === "family.list") {
			result = { families: [TEST_FAMILY] };
		} else if (type === "family.get") {
			result = { family: TEST_FAMILY };
		} else if (type === "bot.list") {
			result = { bots: [TEST_BOT] };
		} else if (type === "account.models.list") {
			result = {
				models: [
					{
						id: "faux/echo",
						provider: "faux",
						name: "Offline Echo",
						contextWindow: 4096,
						maxTokens: 2048,
					},
				],
			};
		} else if (type === "file.list") {
			result = { files: TEST_FILES };
		} else if (type === "file.read") {
			const doc: FileReadDocResult = {
				path: "SOUL.md",
				content: "# System Prompt\nYou are Cadmus.",
				text: "# System Prompt\nYou are Cadmus.",
				version: 1,
			};
			result = doc;
		} else if (type === "chat.list") {
			result = { chats: [TEST_CHAT] };
		} else if (type === "chat.get") {
			result = {
				chat: TEST_CHAT,
				busy: false,
				messages: [],
				entries: [],
				notes: [],
			};
		} else if (type === "turn.command") {
			const statusRec: ChatStatusRecord = {
				chatKey: TEST_CHAT.key,
				conversationId: 1,
				botId: TEST_BOT.id,
				botName: TEST_BOT.name,
				model: TEST_BOT.model,
				thinking: TEST_BOT.thinking,
				tools: TEST_BOT.tools ?? "all",
				busy: false,
				entryCount: 2,
				harvestWatermark: 2,
				nextWakeAt: null,
				usage: { totalTokens: 150 },
			};
			result = {
				outOfBand: true,
				command: "/status",
				status: statusRec,
				text: "Bot: Cadmus Assistant\nModel: faux/echo\nStatus: Idle",
			};
		} else if (type === "schedule.list") {
			result = { schedules: [TEST_SCHEDULE, TEST_HARVEST_SCHEDULE] };
		} else if (type === "schedule.create") {
			result = {
				schedule: {
					id: "sched-new",
					...(payload as object),
					nextRun: 1700003600000,
					inSeconds: 3600,
				},
			};
		} else if (type === "schedule.update") {
			result = {
				schedule: {
					...TEST_SCHEDULE,
					...(payload as object),
				},
			};
		} else if (type === "schedule.delete") {
			result = { ok: true };
		}

		const frame: CommandResultFrame = {
			id: body.id,
			type: "command.result",
			command: type,
			ok: true,
			result,
		};
		return new Response(JSON.stringify(frame));
	};

	return new CadmusClient({
		baseUrl: "",
		userId: "test-user",
		accountId: "acc-test",
		familyId: "fam-test",
		token: "test-token",
		fetchImpl: mockFetch,
	});
}

describe("Web UI Components", () => {
	it("1. TopBar renders brand, user badge, family picker, and tab navigation", () => {
		const client = createMockClient();
		const html = renderToString(
			<CadmusProvider
				clientOverride={client}
				initialConfig={{
					userId: "alice",
					accountId: "acme-corp",
					familyId: "fam-test",
				}}
			>
				<TopBar />
			</CadmusProvider>,
		);

		expect(html).toContain("Cadmus");
		expect(html).toContain("Bot Family DO");
		expect(html).toContain("alice @ acme-corp");
		expect(html).toContain("Chat");
		expect(html).toContain("Bots &amp; Files");
		expect(html).toContain("Schedules &amp; Harvest");
		expect(html).toContain("+ New Family");
		expect(html).toContain("Family Info");
	});

	it("2. BotDirectory renders bot personas and their configuration tags", () => {
		const client = createMockClient();
		const html = renderToString(
			<CadmusProvider clientOverride={client}>
				<BotDirectory />
			</CadmusProvider>,
		);

		expect(html).toContain("Bots &amp; Personas");
		expect(html).toContain("+ New Bot");
	});

	it("3. FileInspector renders virtual files and editor workspace", () => {
		const client = createMockClient();
		const html = renderToString(
			<CadmusProvider clientOverride={client}>
				<FileInspector />
			</CadmusProvider>,
		);

		// If no bot selected in initial render, displays appropriate container
		expect(html).toContain("editor-main-area");
	});

	it("4. Full App shell renders top bar, main content, and bottom status bar", () => {
		const client = createMockClient();
		const html = renderToString(
			<App
				clientOverride={client}
				initialConfig={{
					userId: "dev-tester",
					accountId: "test-account",
					familyId: "fam-test",
				}}
			/>,
		);

		expect(html).toContain("app-container");
		expect(html).toContain("top-bar");
		expect(html).toContain("bottom-status-bar");
		expect(html).toContain("dev-tester");
		expect(html).toContain("test-account");
	});

	it("5. Client correctly calls bot and file mutations with optimistic concurrency", async () => {
		let capturedType = "";
		let capturedPayload: unknown = null;

		const client = createMockClient({
			onRpc: (type, payload) => {
				capturedType = type;
				capturedPayload = payload;
				if (type === "bot.create") {
					return {
						bot: {
							id: "bot-custom",
							name: "Custom Bot",
							model: "faux/echo",
							thinking: "low",
							tools: ["knowledge_read"],
							timezone: "UTC",
							rootConversationId: 2,
							createdAt: Date.now(),
						},
					};
				}
				if (type === "file.write") {
					return {
						path: "knowledge/my-doc.md",
						version: 1,
						description: "Test doc",
						slug: "my-doc",
					};
				}
				return undefined;
			},
		});

		// Test bot.create call
		const botRes = await client.callRpc("bot.create", {
			name: "Custom Bot",
			model: "faux/echo",
			thinking: "low",
			tools: ["knowledge_read"],
		});
		expect(capturedType).toBe("bot.create");
		expect(capturedPayload).toEqual({
			name: "Custom Bot",
			model: "faux/echo",
			thinking: "low",
			tools: ["knowledge_read"],
		});
		expect(botRes.ok).toBe(true);
		expect(botRes.result?.bot.id).toBe("bot-custom");

		// Test file.write call with CAS expectedVersion
		const fileRes = await client.callRpc("file.write", {
			botId: "bot-custom",
			path: "knowledge/my-doc.md",
			description: "Test doc",
			body: "Hello world",
			expectedVersion: 0,
		});
		expect(capturedType).toBe("file.write");
		expect(capturedPayload).toEqual({
			botId: "bot-custom",
			path: "knowledge/my-doc.md",
			description: "Test doc",
			body: "Hello world",
			expectedVersion: 0,
		});
		expect(fileRes.ok).toBe(true);
	});

	it("6. ChatRenderedView renders assistant headers, thinking accordion, tool calls with server-bound results, markdown formatting, harvest notes, and live streaming", () => {
		const testMessages: TranscriptMessageView[] = [
			{
				id: 1,
				role: "user",
				text: "Can you read guidelines and remember my preference?",
				timestamp: 1700000001000,
			},
			{
				id: 2,
				role: "assistant",
				replyToEntryId: 1,
				model: "faux/echo",
				durationMs: 245,
				usage: { totalTokens: 180 },
				timestamp: 1700000002000,
				text: "Here are the guidelines.\n\n### Coding Guidelines\n- Write clean code\n- Use Biome\n\n```ts\nconst ok = true;\n```",
				blocks: [
					{
						type: "thinking",
						thinking: "I should inspect guidelines and then update memory.",
					},
					{
						type: "toolCall",
						id: "call-kb-1",
						name: "knowledge_read",
						arguments: { slug: "guidelines" },
						result: {
							content: "Rule 1: Always check types",
							isError: false,
							durationMs: 32,
						},
					},
					{
						type: "text",
						text: "Here are the guidelines.\n\n### Coding Guidelines\n- Write clean code\n- Use Biome\n\n```ts\nconst ok = true;\n```",
					},
				],
			},
			// Standalone toolResult whose ID is already bound onto message #2
			{
				id: 3,
				role: "toolResult",
				toolCallId: "call-kb-1",
				toolName: "knowledge_read",
				text: "Rule 1: Always check types",
				isError: false,
			},
		];

		const testNotes: HarvestNote[] = [
			{
				chatKey: "chat-main",
				at: 2,
				when: 1700000003000,
				files: [
					{
						path: "MEMORY.md",
						diff: "@@ -1,1 +1,2 @@\n+ User prefers clean types",
					},
				],
			},
		];

		const streamingState = {
			active: true,
			thinking: "Live reasoning tokens coming in...",
			text: "Streaming live response text",
			toolCalls: [
				{
					toolCallId: "call-live-1",
					toolName: "web.fetch",
					args: { url: "https://example.com" },
					result: {
						content: "Fetched 200 OK",
						isError: false,
					},
				},
			],
		};

		const html = renderToString(
			<ChatRenderedView
				messages={testMessages}
				notes={testNotes}
				streamingState={streamingState}
			/>,
		);

		// User message #1
		expect(html).toContain("#1");
		expect(html).toContain("Can you read guidelines");

		// Assistant message #2
		expect(html).toContain("#2");
		expect(html).toContain("↪ reply to #1");
		expect(html).toContain("faux/echo");
		expect(html).toContain("245ms");
		expect(html).toContain("180 tokens");

		// Thinking block
		expect(html).toContain("🧠 Thinking / Reasoning");
		expect(html).toContain("I should inspect guidelines");

		// Tool call with server-bound result
		expect(html).toContain("knowledge_read");
		expect(html).toContain("#call-kb-1");
		expect(html).toContain("Rule 1: Always check types");
		expect(html).toContain("OK");

		// Formatted Markdown: headings, code blocks, bullet points
		expect(html).toContain("<h3>Coding Guidelines</h3>");
		expect(html).toContain("Write clean code");
		expect(html).toContain("language-ts");
		expect(html).toContain("const ok = true;");

		// Bound toolResult should NOT appear as duplicate top-level message
		expect(html).not.toContain(
			'Tool Result</span><span class="badge badge-ghost">#3',
		);

		// Harvest Note
		expect(html).toContain(
			"Harvested memory/knowledge at entry <strong>#2</strong>",
		);
		expect(html).toContain("MEMORY.md");
		expect(html).toContain("+ User prefers clean types");

		// Live Streaming Assistant Turn
		expect(html).toContain("Streaming...");
		expect(html).toContain("Live reasoning tokens coming in...");
		expect(html).toContain("web.fetch");
		expect(html).toContain("https://example.com");
		expect(html).toContain("Streaming live response text");
		expect(html).toContain("streaming-cursor");
	});

	it("6b. ChatRenderedView collapses tools by default into compact chips and visually merges textless responses into the previous message", () => {
		const testMessages: TranscriptMessageView[] = [
			{
				id: 30,
				role: "user",
				text: "Remember that I live in Israel.",
				timestamp: 1700000000000,
			},
			{
				id: 33,
				role: "assistant",
				replyToEntryId: 30,
				model: "grok-4.3",
				durationMs: 1203,
				usage: { totalTokens: 5072 },
				timestamp: 1700000001000,
				text: "Got it — I'll remember that you live in Israel.",
				toolCalls: [
					{
						id: "call-read-1",
						name: "memory_read",
						arguments: {},
						result: {
							content: "Current memory empty",
							isError: false,
						},
					},
				],
			},
			{
				id: 37,
				role: "assistant",
				replyToEntryId: 30,
				model: "grok-4.3",
				durationMs: 1281,
				usage: { totalTokens: 5126 },
				timestamp: 1700000002000,
				// No text in this response — intermediate tool execution
				text: "",
				toolCalls: [
					{
						id: "call-update-2",
						name: "memory_update",
						arguments: { location: "Israel" },
						result: {
							content: "Memory saved",
							isError: false,
						},
					},
				],
			},
			{
				id: 43,
				role: "assistant",
				replyToEntryId: 30,
				model: "grok-4.3",
				durationMs: 1290,
				usage: { totalTokens: 5165 },
				timestamp: 1700000004000,
				text: "Done. I've updated the memory.",
			},
		];

		const harvestNotes: HarvestNote[] = [
			{
				chatKey: "direct:user-1",
				at: 37,
				when: 1700000002500,
				files: [
					{
						path: "MEMORY.md",
						diff: "+ User lives in Israel",
					},
				],
			},
		];

		const html = renderToString(
			<ChatRenderedView
				messages={testMessages}
				notes={harvestNotes}
				streamingState={{
					active: false,
					thinking: "",
					text: "",
					toolCalls: [],
				}}
			/>,
		);

		// 1. User message #30 is present
		expect(html).toContain("#30");
		expect(html).toContain("Remember that I live in Israel.");

		// 2. Assistant message #33 is present with text and BOTH tool chips
		expect(html).toContain("#33");
		expect(html).toContain(
			"Got it — I&#x27;ll remember that you live in Israel.",
		);
		expect(html).toContain("memory_read");
		expect(html).toContain("memory_update");
		expect(html).toContain("tool-chips-row");

		// 3. Response without text (#37) was visually merged into #33 and does NOT render as its own message row
		expect(html).not.toContain('<span class="badge badge-ghost">#37</span>');

		// 4. Harvest note for merged entry #37 is preserved and rendered with #33
		expect(html).toContain(
			"Harvested memory/knowledge at entry <strong>#37</strong>",
		);
		expect(html).toContain("+ User lives in Israel");

		// 5. Tools are collapsed by default: <details class="tool-call-card"> must not have the 'open' attribute
		expect(html).toContain('<details class="tool-call-card">');
		expect(html).not.toContain('<details class="tool-call-card" open');

		// 6. Assistant message #43 is present with its final text
		expect(html).toContain("#43");
		expect(html).toContain("Done. I&#x27;ve updated the memory.");
	});

	it("7. ChatRawView renders low-level messages, system sections, inner blocks, token usage table, and live stream frames", () => {
		const rawEntries: RawTranscriptEntry[] = [
			{
				id: 1,
				conversationId: 42,
				kind: "system",
				model: [
					{
						role: "system",
						content: "You are Cadmus.",
						sections: {
							soul: "Soul prompt content",
							knowledge: "Knowledge prompt content",
						},
						toolsAdded: [
							{
								name: "knowledge_read",
								description: "Read knowledge doc",
								parameters: { type: "object" },
							},
						],
					},
				],
			},
			{
				id: 2,
				conversationId: 42,
				kind: "user",
				model: [
					{
						role: "user",
						content: "Execute task",
						timestamp: 1700000010000,
					},
				],
			},
			{
				id: 3,
				conversationId: 42,
				kind: "assistant",
				model: [
					{
						role: "assistant",
						provider: "faux",
						model: "faux/echo",
						durationMs: 310,
						usage: {
							input: 120,
							output: 80,
							reasoning: 40,
							cacheRead: 20,
							cacheWrite: 0,
							totalTokens: 200,
							cost: { total: 0.0015 },
						},
						content: [
							{
								type: "thinking",
								thinking: "Inner raw reasoning block",
							},
							{
								type: "toolCall",
								id: "call-raw-1",
								name: "schedule_create",
								arguments: { cron: "0 * * * *" },
							},
							{
								type: "text",
								text: "Created hourly schedule.",
							},
						],
					},
				],
				data: { compaction: false, watermark: 3 },
			},
			{
				id: 4,
				conversationId: 42,
				kind: "toolResult",
				model: [
					{
						role: "toolResult",
						toolCallId: "call-raw-1",
						toolName: "schedule_create",
						isError: false,
						content: '{"id":"sched-1"}',
					},
				],
			},
		];

		const liveEvents: ServerEvent[] = [
			{
				type: "turn.delta",
				payload: {
					chatKey: "chat-main",
					kind: "text",
					delta: "hello world",
				},
			},
		];

		const html = renderToString(
			<ChatRawView
				entries={rawEntries}
				messages={[]}
				liveEvents={liveEvents}
			/>,
		);

		// Toolbar counts & filters
		expect(html).toContain("Total: 4");
		expect(html).toContain("system: 1");
		expect(html).toContain("user: 1");
		expect(html).toContain("assistant: 1");
		expect(html).toContain("toolResult: 1");
		expect(html).toContain("Show Raw JSON for All");
		expect(html).toContain("Export JSONL");

		// System sections & declared tools
		expect(html).toContain("Entry #1");
		expect(html).toContain("Section: [soul]");
		expect(html).toContain("Soul prompt content");
		expect(html).toContain("Section: [knowledge]");
		expect(html).toContain("Declared Tools (1)");
		expect(html).toContain("⚙️ knowledge_read");

		// User entry
		expect(html).toContain("Entry #2");
		expect(html).toContain("Execute task");

		// Assistant entry inner blocks & usage table
		expect(html).toContain("Entry #3");
		expect(html).toContain("Block [0] — type: &quot;thinking&quot;");
		expect(html).toContain("Inner raw reasoning block");
		expect(html).toContain("Block [1] — type: &quot;toolCall&quot;");
		expect(html).toContain("call-raw-1");
		expect(html).toContain("schedule_create");
		expect(html).toContain("Block [2] — type: &quot;text&quot;");
		expect(html).toContain("Created hourly schedule.");
		expect(html).toContain("120");
		expect(html).toContain("80");
		expect(html).toContain("200");
		expect(html).toContain("0.0015");

		// Entry data / diagnostics
		expect(html).toContain("Entry Data / Diagnostics");
		expect(html).toContain("watermark");

		// Live frames
		expect(html).toContain("Live Stream Frames (1)");
		expect(html).toContain("turn.delta");
	});

	it("8. ChatWorkspace loads chats, toggles between Rendered and Raw views, and opens out-of-band /status drawer", () => {
		const client = createMockClient();

		const html = renderToString(
			<CadmusProvider clientOverride={client}>
				<ChatWorkspace
					initialChats={[TEST_CHAT]}
					initialSelectedKey={TEST_CHAT.key}
					initialChatData={{
						chat: TEST_CHAT,
						busy: false,
						messages: [],
						entries: [],
						notes: [],
					}}
				/>
			</CadmusProvider>,
		);

		// Sidebar
		expect(html).toContain("Chats");
		expect(html).toContain("+ New Chat");
		expect(html).toContain("Main Discussion");
		expect(html).toContain("#chat-main");

		// Header bar with view toggles and actions
		expect(html).toContain("Rendered");
		expect(html).toContain("Raw (Blocks)");
		expect(html).toContain("⚡ /status");
		expect(html).toContain("Rename");
		expect(html).toContain("Export JSONL");
		expect(html).toContain("Reset");
		expect(html).toContain("Close");

		// Prompt input
		expect(html).toContain("Type a prompt");
		expect(html).toContain("Send Prompt");
	});

	it("9. SchedulesPanel renders schedule cards, badges, expressions, countdowns, and header controls", () => {
		const client = createMockClient();

		const html = renderToString(
			<CadmusProvider clientOverride={client}>
				<SchedulesPanel
					initialSchedules={[TEST_SCHEDULE, TEST_HARVEST_SCHEDULE]}
				/>
			</CadmusProvider>,
		);

		// Header Controls
		expect(html).toContain("Scheduled Tasks");
		expect(html).toContain("All Bots");
		expect(html).toContain("Show internal harvest timers");
		expect(html).toContain("↻ Refresh");
		expect(html).toContain("+ New Schedule");

		// Regular Schedule Card
		expect(html).toContain("Hourly Summary");
		expect(html).toContain("sched-hourly-summary");
		expect(html).toContain("assistant");
		expect(html).toContain("cron");
		expect(html).toContain("recurring");
		expect(html).toContain("Enabled");
		expect(html).toContain("0 * * * *");
		expect(html).toContain("new-chat");
		expect(html).toContain("in 3600s");
		expect(html).toContain("thinking: medium");
		expect(html).toContain("Summarize recent activity in the workspace.");
		expect(html).toContain("Disable");
		expect(html).toContain("Edit");
		expect(html).toContain("Delete");

		// Internal Harvest Schedule Card
		expect(html).toContain("Idle Harvest Timer");
		expect(html).toContain("harvest:chat-main");
		expect(html).toContain("relative");
		expect(html).toContain("internal");
		expect(html).toContain("fork: chat-main @ #5 (harvest)");
		expect(html).toContain("60s");
		expect(html).toContain("in 45s");
		expect(html).toContain(
			"Extract long-term memory updates from conversation history.",
		);
	});

	it("10. HarvestInspector renders conversation harvest audit history, watermarks, file count, and UnifiedDiffViewer lines", () => {
		const client = createMockClient();

		const html = renderToString(
			<CadmusProvider clientOverride={client}>
				<HarvestInspector initialNotes={[TEST_HARVEST_NOTE]} />
			</CadmusProvider>,
		);

		// Header Controls
		expect(html).toContain("Harvest Inspector");
		expect(html).toContain("1 notes");
		expect(html).toContain("Live WS");
		expect(html).toContain("Chat Filter:");
		expect(html).toContain("↻ Refresh");

		// Note Card Header
		expect(html).toContain("Chat: chat-main");
		expect(html).toContain("Watermark: Entry #5");
		expect(html).toContain("2 file(s)");

		// File badges
		expect(html).toContain("MEMORY.md");
		expect(html).toContain("knowledge/architecture.md");

		// Unified Diff Viewer lines and styling
		// Added lines (.diff-line-add)
		expect(html).toContain("diff-line diff-line-add");
		expect(html).toContain("+Needs weekly reminders on Mondays.");
		expect(html).toContain(
			"+Project utilizes Cloudflare Workers and Durable Objects.",
		);
		expect(html).toContain("+Uses DO SQLite with Cas CAS mutations.");

		// Deleted lines (.diff-line-del)
		expect(html).toContain("diff-line diff-line-del");
		expect(html).toContain("-Needs daily reminders.");

		// Hunk headers (.diff-line-hunk)
		expect(html).toContain("diff-line diff-line-hunk");
		expect(html).toContain("@@ -1,4 +1,5 @@");
		expect(html).toContain("@@ -1 +1,2 @@");

		// Context and header lines (.diff-line)
		expect(html).toContain("--- a/MEMORY.md");
		expect(html).toContain("+++ b/MEMORY.md");
		expect(html).toContain("# Memory");
		expect(html).toContain("User prefers concise bullet points.");

		// Gutters
		expect(html).toContain("diff-gutter");
		expect(html).toContain("diff-prefix");
		expect(html).toContain("diff-content");
	});

	it("11. UnifiedDiffViewer handles empty diffs and parses multi-hunk diffs correctly", () => {
		// Empty diff
		const emptyHtml = renderToString(<UnifiedDiffViewer diff="" />);
		expect(emptyHtml).toContain("(Empty diff)");

		// Custom diff with additions, deletions, hunks, context
		const sampleDiff = [
			"--- a/config.json",
			"+++ b/config.json",
			"@@ -10,3 +10,4 @@",
			'   "port": 8787,',
			'-  "env": "dev",',
			'+  "env": "production",',
			'+  "tls": true,',
		].join("\n");

		const customHtml = renderToString(<UnifiedDiffViewer diff={sampleDiff} />);
		expect(customHtml).toContain("diff-container");
		expect(customHtml).toContain("diff-line diff-line-del");
		expect(customHtml).toContain("-  &quot;env&quot;: &quot;dev&quot;,");
		expect(customHtml).toContain("diff-line diff-line-add");
		expect(customHtml).toContain("+  &quot;env&quot;: &quot;production&quot;,");
		expect(customHtml).toContain("+  &quot;tls&quot;: true,");
		expect(customHtml).toContain("diff-line diff-line-hunk");
		expect(customHtml).toContain("@@ -10,3 +10,4 @@");
	});

	it("12. Client schedule mutations trigger schedule.create, schedule.update, and schedule.delete RPCs", async () => {
		let capturedType = "";
		let capturedPayload: unknown = null;

		const client = createMockClient({
			onRpc: (type, payload) => {
				capturedType = type;
				capturedPayload = payload;
				if (type === "schedule.create") {
					return {
						schedule: {
							id: "sched-nightly",
							...(payload as object),
							nextRun: 1700050000000,
							inSeconds: 7200,
						},
					};
				}
				if (type === "schedule.update") {
					return {
						schedule: {
							...TEST_SCHEDULE,
							...(payload as object),
						},
					};
				}
				if (type === "schedule.delete") {
					return { ok: true };
				}
				return undefined;
			},
		});

		// 1. Create schedule
		const createRes = await client.callRpc("schedule.create", {
			botId: "assistant",
			name: "Nightly Backup",
			kind: "cron",
			input: "0 0 * * *",
			text: "Perform nightly consistency backup.",
			target: { mode: "new-chat" },
			thinking: "low",
			enabled: true,
		});
		expect(capturedType).toBe("schedule.create");
		expect(capturedPayload).toEqual({
			botId: "assistant",
			name: "Nightly Backup",
			kind: "cron",
			input: "0 0 * * *",
			text: "Perform nightly consistency backup.",
			target: { mode: "new-chat" },
			thinking: "low",
			enabled: true,
		});
		expect(createRes.ok).toBe(true);
		expect(createRes.result?.schedule.id).toBe("sched-nightly");

		// 2. Toggle enable schedule
		const updateRes = await client.callRpc("schedule.update", {
			id: "sched-hourly-summary",
			enabled: false,
		});
		expect(capturedType).toBe("schedule.update");
		expect(capturedPayload).toEqual({
			id: "sched-hourly-summary",
			enabled: false,
		});
		expect(updateRes.ok).toBe(true);

		// 3. Delete schedule
		const deleteRes = await client.callRpc("schedule.delete", {
			id: "sched-hourly-summary",
		});
		expect(capturedType).toBe("schedule.delete");
		expect(capturedPayload).toEqual({
			id: "sched-hourly-summary",
		});
		expect(deleteRes.ok).toBe(true);
	});

	it("13. Full App shell renders split-pane Schedules and Harvest view when activeTab is 'schedules'", () => {
		const client = createMockClient();

		const html = renderToString(
			<App initialActiveTab="schedules" clientOverride={client} />,
		);

		// App layout components
		expect(html).toContain("app-container");
		expect(html).toContain("top-bar");
		expect(html).toContain("bottom-status-bar");

		// Schedules and Harvest split pane
		expect(html).toContain("schedules-view-container");
		expect(html).toContain("schedules-pane");
		expect(html).toContain("harvest-pane");
		expect(html).toContain("Scheduled Tasks");
		expect(html).toContain("Harvest Inspector");
	});

	it("14. Tools env pins submit Inherit, On, and Off as envId-only payloads", () => {
		expect(buildToolsEnvSetting({ choice: "inherit" })).toBeNull();
		expect(
			buildToolsEnvSetting({ choice: "off", retainEnvId: "ld_laptop" }),
		).toEqual({
			enabled: false,
			binding: { envId: "ld_laptop" },
		});
		expect(buildToolsEnvSetting({ choice: "off" })).toEqual({ enabled: false });
		const onDaemon = buildToolsEnvSetting({
			choice: "on",
			envId: "ld_laptop",
		});
		expect(onDaemon).toEqual({
			enabled: true,
			binding: { envId: "ld_laptop" },
		});
		expect(onDaemon).not.toHaveProperty("workspacePath");
		expect(onDaemon).not.toHaveProperty("secretId");
		expect(JSON.stringify(onDaemon)).not.toContain("token");
		expect(JSON.stringify(onDaemon)).not.toContain("cadmus_dt_");

		const html = renderToString(
			<ToolsEnvPinFields
				idPrefix="bot-tools-env"
				choice="on"
				envId="ld_laptop"
				envs={[
					{ envId: "jb_default", kind: "just-bash", label: "Default" },
					{ envId: "ld_laptop", kind: "local-daemon", label: "Laptop" },
				]}
				onChoice={() => undefined}
				onEnvId={() => undefined}
			/>,
		);
		expect(html).toContain("Inherit");
		expect(html).toContain("On");
		expect(html).toContain("Off");
		expect(html).toContain('value="jb_default"');
		expect(html).toContain('value="ld_laptop"');
		expect(html).toContain("local-daemon");
		expect(html).not.toContain("cadmus_dt_");
		expect(html).not.toContain("connected");
		expect(html).not.toContain("probe");
		const summary = formatToolsEnvSummary({
			stored: { enabled: true, binding: { envId: "ld_laptop" } },
			enabled: true,
			effective: { kind: "local-daemon", envId: "ld_laptop" },
			status: "disconnected",
			connectedAt: Date.UTC(2026, 0, 2),
			lastError: "secret_missing",
		});
		expect(summary).toContain("disconnected");
		expect(summary).toContain("secret_missing");
		expect(summary).toContain("connectedAt");
		expect(summary).not.toContain("probe");
	});

	it("15. Edit sends tools only when the tools field or coding checkbox changed", () => {
		const unchangedDefault = toolsFormBaseline(undefined);
		expect(toolsPayload("", false, "edit", unchangedDefault)).toBeUndefined();

		const explicit = toolsFormBaseline(["memory_read", "knowledge_read"]);
		expect(
			toolsPayload(
				explicit.toolsText,
				explicit.includeCoding,
				"edit",
				explicit,
			),
		).toBeUndefined();
		const renamed = {
			botId: "assistant",
			name: "Renamed",
			tools: toolsPayload(
				explicit.toolsText,
				explicit.includeCoding,
				"edit",
				explicit,
			),
		};
		expect(JSON.parse(JSON.stringify(renamed))).toEqual({
			botId: "assistant",
			name: "Renamed",
		});
		expect(renamed.tools).not.toBeNull();

		const codingOnly = toolsFormBaseline(["bash", "read", "write", "edit"]);
		expect(codingOnly.includeCoding).toBe(true);
		expect(
			toolsPayload(codingOnly.toolsText, false, "edit", codingOnly),
		).toEqual([]);

		const listed = toolsFormBaseline(["memory_read"]);
		expect(
			toolsPayload("memory_read, knowledge_read", false, "edit", listed),
		).toEqual(["memory_read", "knowledge_read"]);

		expect(toolsPayload("", false, "create")).toBeUndefined();
		const create = {
			name: "Assistant",
			tools: toolsPayload("", false, "create"),
		};
		expect(JSON.parse(JSON.stringify(create))).toEqual({ name: "Assistant" });
		const cleared = {
			botId: "assistant",
			tools: toolsPayload(codingOnly.toolsText, false, "edit", codingOnly),
		};
		expect(JSON.parse(JSON.stringify(cleared)).tools).toEqual([]);
		expect(cleared.tools).not.toBeNull();
	});

	it("16. Chat autoscroll logic and useAutoScroll hook maintain bottom anchor when at bottom and preserve position when scrolled up", () => {
		// 1. isNearBottom threshold boundary checks
		expect(SCROLL_BOTTOM_THRESHOLD).toBe(50);
		// Exactly at bottom
		expect(isNearBottom(1000, 500, 500)).toBe(true);
		// Within 50px of bottom
		expect(isNearBottom(1000, 460, 500)).toBe(true);
		expect(isNearBottom(1000, 450, 500)).toBe(true);
		// Scrolled up past threshold
		expect(isNearBottom(1000, 449, 500)).toBe(false);
		expect(isNearBottom(1000, 200, 500)).toBe(false);
		expect(isNearBottom(1000, 0, 500)).toBe(false);
		// Container content shorter than viewport
		expect(isNearBottom(300, 0, 500)).toBe(true);

		// 2. Simulated element and handleScroll testing
		let currentScrollTop = 500;
		const currentScrollHeight = 1000;
		const fakeElement = {
			get scrollTop() {
				return currentScrollTop;
			},
			set scrollTop(val: number) {
				currentScrollTop = val;
			},
			get scrollHeight() {
				return currentScrollHeight;
			},
			clientHeight: 500,
		} as unknown as HTMLDivElement;

		// Test hook with simulated element
		let hookResult:
			| ReturnType<typeof useAutoScroll<HTMLDivElement>>
			| undefined;
		function TestScrollComponent(props: {
			chatKey?: string;
			streamingActive?: boolean;
			hasNewUserMessage?: boolean;
		}) {
			const res = useAutoScroll<HTMLDivElement>(props);
			hookResult = res;
			return null;
		}

		// Initial render: starts at bottom
		renderToString(<TestScrollComponent chatKey="chat-1" />);
		expect(hookResult).toBeDefined();
		if (!hookResult) throw new Error("hookResult was not captured");

		expect(hookResult.isAtBottomRef.current).toBe(true);

		// Assign fake ref
		hookResult.scrollRef.current = fakeElement;

		// User scrolls up
		currentScrollTop = 100;
		hookResult.handleScroll();
		expect(hookResult.isAtBottomRef.current).toBe(false);

		// While scrolled up, user scrolls near bottom (470px out of 500 max scroll, diff 30px <= 50)
		currentScrollTop = 470;
		hookResult.handleScroll();
		expect(hookResult.isAtBottomRef.current).toBe(true);

		// User scrolls up again
		currentScrollTop = 200;
		hookResult.handleScroll();
		expect(hookResult.isAtBottomRef.current).toBe(false);

		// Programmatic scrollToBottom
		hookResult.scrollToBottom();
		expect(currentScrollTop).toBe(1000);
		expect(hookResult.isAtBottomRef.current).toBe(true);

		// If user was scrolled up and chatKey changes, it resets to bottom
		currentScrollTop = 200;
		hookResult.handleScroll();
		expect(hookResult.isAtBottomRef.current).toBe(false);

		renderToString(<TestScrollComponent chatKey="chat-2" />);
		if (!hookResult) throw new Error("hookResult was not captured");
		expect(hookResult.isAtBottomRef.current).toBe(true);

		// If user was scrolled up and streaming becomes active (new turn started), resets to bottom
		hookResult.scrollRef.current = fakeElement;
		currentScrollTop = 200;
		hookResult.handleScroll();
		expect(hookResult.isAtBottomRef.current).toBe(false);

		renderToString(
			<TestScrollComponent chatKey="chat-2" streamingActive={true} />,
		);
		if (!hookResult) throw new Error("hookResult was not captured");
		expect(hookResult.isAtBottomRef.current).toBe(true);

		// If user was scrolled up and user message was submitted, resets to bottom
		hookResult.scrollRef.current = fakeElement;
		currentScrollTop = 200;
		hookResult.handleScroll();
		expect(hookResult.isAtBottomRef.current).toBe(false);

		renderToString(
			<TestScrollComponent chatKey="chat-2" hasNewUserMessage={true} />,
		);
		if (!hookResult) throw new Error("hookResult was not captured");
		expect(hookResult.isAtBottomRef.current).toBe(true);
	});

	it("17. Save tools env button is enabled ONLY when settings changed in the UI and disabled when unchanged", () => {
		// Inherit baseline (stored is null/undefined)
		expect(
			hasToolsEnvChanged({ stored: null, choice: "inherit", envId: "" }),
		).toBe(false);
		expect(
			hasToolsEnvChanged({ stored: undefined, choice: "inherit", envId: "" }),
		).toBe(false);
		expect(hasToolsEnvChanged({ stored: null, choice: "on", envId: "" })).toBe(
			true,
		);
		expect(
			hasToolsEnvChanged({ stored: null, choice: "on", envId: "jb_default" }),
		).toBe(true);
		expect(hasToolsEnvChanged({ stored: null, choice: "off", envId: "" })).toBe(
			true,
		);

		// On baseline with pinned envId
		const storedPinned = {
			enabled: true,
			binding: { envId: "jb_default" },
		};
		expect(
			hasToolsEnvChanged({
				stored: storedPinned,
				choice: "on",
				envId: "jb_default",
			}),
		).toBe(false);
		expect(
			hasToolsEnvChanged({
				stored: storedPinned,
				choice: "on",
				envId: "ld_laptop",
			}),
		).toBe(true);
		expect(
			hasToolsEnvChanged({
				stored: storedPinned,
				choice: "on",
				envId: "",
			}),
		).toBe(true);
		expect(
			hasToolsEnvChanged({
				stored: storedPinned,
				choice: "inherit",
				envId: "jb_default",
			}),
		).toBe(true);
		expect(
			hasToolsEnvChanged({
				stored: storedPinned,
				choice: "off",
				envId: "jb_default",
			}),
		).toBe(true);

		// On baseline with account default (no binding / empty envId)
		const storedDefault = { enabled: true };
		expect(
			hasToolsEnvChanged({
				stored: storedDefault,
				choice: "on",
				envId: "",
			}),
		).toBe(false);
		expect(
			hasToolsEnvChanged({
				stored: storedDefault,
				choice: "on",
				envId: "jb_default",
			}),
		).toBe(true);
		expect(
			hasToolsEnvChanged({
				stored: storedDefault,
				choice: "inherit",
				envId: "",
			}),
		).toBe(true);
		expect(
			hasToolsEnvChanged({
				stored: storedDefault,
				choice: "off",
				envId: "",
			}),
		).toBe(true);

		// Off baseline
		const storedOff = { enabled: false };
		expect(
			hasToolsEnvChanged({
				stored: storedOff,
				choice: "off",
				envId: "",
			}),
		).toBe(false);
		expect(
			hasToolsEnvChanged({
				stored: storedOff,
				choice: "inherit",
				envId: "",
			}),
		).toBe(true);
		expect(
			hasToolsEnvChanged({
				stored: storedOff,
				choice: "on",
				envId: "",
			}),
		).toBe(true);

		// Verify ChatWorkspace initial render has "Save tools env" button disabled
		const client = createMockClient();
		const html = renderToString(
			<CadmusProvider clientOverride={client}>
				<ChatWorkspace
					initialChats={[TEST_CHAT]}
					initialSelectedKey={TEST_CHAT.key}
					initialChatData={{
						chat: TEST_CHAT,
						busy: false,
						messages: [],
						entries: [],
						notes: [],
					}}
				/>
			</CadmusProvider>,
		);

		// Button should be disabled on initial render since settings have not changed
		expect(html).toMatch(
			/<button[^>]*disabled=""[^>]*>[^<]*Save tools env[^<]*<\/button>/,
		);
	});
});
