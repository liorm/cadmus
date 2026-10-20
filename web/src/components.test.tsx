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
import { TopBar } from "./components/TopBar.js";
import { CadmusProvider } from "./context/CadmusContext.js";

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
});
