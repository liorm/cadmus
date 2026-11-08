import {
	availableAllowlistNames,
	CODING_TOOL_NAMES,
	knownReadOnlyToolNames,
} from "@cadmus/contract/tools";
import type { ModelInfo } from "@cadmus/contract/types";
import type { Page } from "@playwright/test";
import { getBot, seedBot, sendAccountRpc } from "../support/account.ts";
import {
	chooseTimezone,
	clickByRole,
	fillByLabel,
} from "../support/actions.ts";
import { expect, test } from "../support/fixtures.ts";

test.describe.configure({ mode: "parallel" });

const WORKER_BASE = "http://127.0.0.1:8799";

async function watchPosts(page: Page) {
	await page.addInitScript(() => {
		const bag = window as unknown as {
			__posts?: Array<{
				url: string;
				body: string;
				ok: boolean;
				status: number;
			}>;
		};
		bag.__posts = [];
		const original = window.fetch.bind(window);
		window.fetch = async (input, init) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.href
						: input.url;
			const body = typeof init?.body === "string" ? init.body : "";
			const res = await original(input, init);
			bag.__posts?.push({
				url,
				body,
				ok: res.ok,
				status: res.status,
			});
			return res;
		};
	});
	return {
		async all() {
			return page.evaluate(
				() =>
					(
						window as unknown as {
							__posts?: Array<{
								url: string;
								body: string;
								ok: boolean;
								status: number;
							}>;
						}
					).__posts ?? [],
			);
		},
	};
}

async function clickSwitch(page: Page, name: string): Promise<void> {
	await page.getByRole("switch", { name, exact: true }).evaluate((node) => {
		(node as HTMLElement).click();
	});
}

function toolSwitch(page: Page, name: string) {
	return page.getByRole("switch", { name, exact: true });
}

async function pageHasToolLabel(page: Page, name: string): Promise<boolean> {
	return page.evaluate((label) => {
		const root = document.querySelector("[data-testid=tool-allowlist]");
		const nodes = root
			? root.querySelectorAll("span")
			: document.querySelectorAll("span");
		return [...nodes].some((node) => node.textContent === label);
	}, name);
}

async function scrollAllowlist(page: Page): Promise<void> {
	await page.evaluate(() => {
		const root = document.querySelector("[data-testid=tool-allowlist]");
		if (root) root.scrollTop = root.scrollHeight;
	});
}

async function choose(page: Page, label: string, value: string): Promise<void> {
	await page.getByLabel(label).evaluate((node, next) => {
		if (!(node instanceof HTMLSelectElement)) return;
		const setter = Object.getOwnPropertyDescriptor(
			HTMLSelectElement.prototype,
			"value",
		)?.set;
		setter?.call(node, next);
		node.dispatchEvent(new Event("change", { bubbles: true }));
	}, value);
}

test("config round-trips a usable model, thinking, and timezone", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await sendAccountRpc(origin, accountId, "account.credentials.set", {
		providerId: "xai",
		credential: { type: "api_key", apiKey: "xai-test-key-12345" },
	});
	const listed = await sendAccountRpc<{ models: ModelInfo[] }>(
		origin,
		accountId,
		"account.models.list",
		{ onlyAuthenticated: true },
	);
	const next = listed.models.find((model) => {
		const ref = model.id.includes("/")
			? model.id
			: `${model.provider}/${model.id}`;
		return ref !== "faux/echo" && model.authenticated;
	});
	expect(next).toBeDefined();
	const nextModel = next
		? next.id.includes("/")
			? next.id
			: `${next.provider}/${next.id}`
		: "";
	expect(nextModel).toMatch(/^[a-z0-9-]+\/.+/);
	expect(nextModel).not.toBe("faux/echo");
	const posts = await watchPosts(page);
	await page.goto("/bot/echo-bot/config");
	await expect(page.getByRole("heading", { name: "Echo Bot" })).toBeVisible();
	await expect(page.getByRole("radio", { name: "Config" })).toBeVisible();
	const model = page.getByLabel("Model");
	await expect(model).toBeVisible();
	await expect(model).toHaveValue("faux/echo");
	await expect
		.poll(async () =>
			model.evaluate((node) =>
				node instanceof HTMLSelectElement
					? [...node.options].map((option) => option.value)
					: [],
			),
		)
		.toContain(nextModel);
	await choose(page, "Model", nextModel);
	for (const level of ["Off", "Minimal", "Low", "Medium", "High"]) {
		await clickByRole(page, "radio", level);
	}
	await chooseTimezone(page, "Timezone", "Asia/Jerusalem", "keyboard");
	await expect
		.poll(async () =>
			(await posts.all()).some(
				(hit) =>
					hit.url.includes("/api/bot/update") &&
					hit.body.includes('"timezone":"Asia/Jerusalem"') &&
					hit.ok,
			),
		)
		.toBe(true);
	await expect
		.poll(async () =>
			(await posts.all()).some(
				(hit) =>
					hit.url.includes("/api/bot/update") &&
					hit.body.includes('"thinking":"high"') &&
					hit.ok,
			),
		)
		.toBe(true);
	await expect
		.poll(async () =>
			(await posts.all()).some(
				(hit) =>
					hit.url.includes("/api/bot/update") &&
					hit.body.includes(`"model":"${nextModel}"`) &&
					hit.ok,
			),
		)
		.toBe(true);
	const stored = await getBot(origin, accountId, "echo-bot");
	expect(stored.model).toBe(nextModel);
	expect(stored.timezone).toBe("Asia/Jerusalem");
	await page.reload();
	await expect(page.getByLabel("Model")).toHaveValue(nextModel);
	await expect(page.getByLabel("Timezone")).toHaveValue("Asia/Jerusalem");
	await expect(page.getByRole("radio", { name: "High" })).toHaveAttribute(
		"data-state",
		"on",
	);
});

test("config timezone ignores free text", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	const posts = await watchPosts(page);
	await page.goto("/bot/echo-bot/config");
	const input = page.getByRole("combobox", { name: "Timezone" });
	await expect(input).toHaveValue("UTC");
	await input.click();
	await input.fill("Not/AZone");
	await input.press("Escape");
	await expect(input).toHaveValue("UTC");
	await page.reload();
	await expect(page.getByRole("combobox", { name: "Timezone" })).toHaveValue(
		"UTC",
	);
	const stored = await getBot(origin, accountId, "echo-bot");
	expect(stored.timezone).toBe("UTC");
	const hits = await posts.all();
	expect(
		hits.some(
			(hit) =>
				hit.url.includes("/api/bot/update") && hit.body.includes("Not/AZone"),
		),
	).toBe(false);
});

test("tool allowlist hides coding tools without an env and persists", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await sendAccountRpc(origin, accountId, "bot.update", {
		botId: "echo-bot",
		toolsEnv: { enabled: false },
	});
	const posts = await watchPosts(page);
	await page.goto("/bot/echo-bot/config");
	await clickByRole(page, "button", "Tool allowlist");
	await expect(
		page.getByRole("heading", { name: "Tool allowlist" }),
	).toBeVisible();
	await expect(toolSwitch(page, "memory_read")).toBeVisible();
	await scrollAllowlist(page);
	await expect
		.poll(async () => pageHasToolLabel(page, "code.execute"))
		.toBe(true);
	for (const name of CODING_TOOL_NAMES) {
		await expect(toolSwitch(page, name)).toHaveCount(0);
	}
	await clickSwitch(page, "memory_read");
	await clickByRole(page, "button", "Save");
	await expect
		.poll(async () =>
			(await posts.all()).some(
				(hit) =>
					hit.url.includes("/api/bot/update") &&
					hit.body.includes('"tools":[') &&
					!hit.body.includes("memory_read") &&
					hit.ok,
			),
		)
		.toBe(true);
	await page.reload();
	await expect(toolSwitch(page, "memory_read")).toHaveAttribute(
		"data-state",
		"unchecked",
	);
	const stored = await getBot(origin, accountId, "echo-bot");
	expect(stored.tools).toBeDefined();
	expect(stored.tools).not.toContain("memory_read");
	for (const name of CODING_TOOL_NAMES) {
		expect(stored.tools).not.toContain(name);
	}
	await clickByRole(page, "button", "Reset to default");
	await expect
		.poll(async () =>
			(await posts.all()).some(
				(hit) =>
					hit.url.includes("/api/bot/update") &&
					hit.body.includes('"tools":null') &&
					hit.ok,
			),
		)
		.toBe(true);
	const reset = await getBot(origin, accountId, "echo-bot");
	expect(reset.tools).toBeUndefined();
});

test("tools env picker pins an account env", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	const created = await sendAccountRpc<{ env: { envId: string } }>(
		origin,
		accountId,
		"account.toolsEnvs.create",
		{ kind: "just-bash", label: "home-pi" },
	);
	const posts = await watchPosts(page);
	await page.goto("/bot/echo-bot/config");
	await clickByRole(page, "button", "Tools environment");
	await clickByRole(page, "button", "On · home-pi");
	await expect
		.poll(async () =>
			(await posts.all()).some(
				(hit) =>
					hit.url.includes("/api/bot/update") &&
					hit.body.includes('"enabled":true') &&
					hit.body.includes(created.env.envId),
			),
		)
		.toBe(true);
	await expect(page.getByText("On · home-pi")).toBeVisible();
	await clickByRole(page, "button", "Tool allowlist");
	await expect(toolSwitch(page, "bash")).toBeVisible();
	for (const name of CODING_TOOL_NAMES) {
		await expect(toolSwitch(page, name)).toBeVisible();
	}
	await expect
		.poll(async () => pageHasToolLabel(page, "code.execute"))
		.toBe(false);
	await page.goto("/bot/echo-bot/config");
	await clickByRole(page, "button", "Tools environment");
	await clickByRole(page, "button", "Off");
	await clickByRole(page, "button", "Tool allowlist");
	for (const name of CODING_TOOL_NAMES) {
		await expect(toolSwitch(page, name)).toHaveCount(0);
	}
	await expect
		.poll(async () => pageHasToolLabel(page, "code.execute"))
		.toBe(true);
});

test("selecting a coding env does not expand an explicit allowlist", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await sendAccountRpc(origin, accountId, "bot.update", {
		botId: "echo-bot",
		tools: ["memory_read", "knowledge_read"],
	});
	const created = await sendAccountRpc<{ env: { envId: string } }>(
		origin,
		accountId,
		"account.toolsEnvs.create",
		{ kind: "just-bash", label: "shop-pi" },
	);
	await sendAccountRpc(origin, accountId, "bot.update", {
		botId: "echo-bot",
		toolsEnv: { enabled: true, binding: { envId: created.env.envId } },
	});
	await page.goto("/bot/echo-bot/tools");
	await expect(toolSwitch(page, "bash")).toBeVisible();
	await expect(toolSwitch(page, "bash")).toHaveAttribute(
		"data-state",
		"unchecked",
	);
	await clickByRole(page, "button", "Save");
	const stored = await getBot(origin, accountId, "echo-bot");
	expect(stored.tools).toEqual(["memory_read", "knowledge_read"]);
	expect(stored.tools).not.toContain("bash");
});

test("allowlist categories persist mixed state after reload", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await page.goto("/bot/echo-bot/tools");
	const knowledge = page.getByRole("checkbox", { name: "Knowledge" });
	await knowledge.evaluate((node) => {
		(node as HTMLInputElement).click();
	});
	await expect(knowledge).toHaveJSProperty("checked", false);
	await clickSwitch(page, "memory_read");
	await expect(knowledge).toHaveAttribute("aria-checked", "mixed");
	await clickByRole(page, "button", "Save");
	await page.reload();
	await expect(
		page.getByRole("checkbox", { name: "Knowledge" }),
	).toHaveAttribute("aria-checked", "mixed");
	await expect(toolSwitch(page, "memory_read")).toHaveAttribute(
		"data-state",
		"checked",
	);
	await expect(toolSwitch(page, "knowledge_update")).toHaveAttribute(
		"data-state",
		"unchecked",
	);
	const stored = await getBot(origin, accountId, "echo-bot");
	expect(stored.tools).toContain("memory_read");
	expect(stored.tools).not.toContain("knowledge_update");
});

test("read-only mode enables known reads only and restores the prior selection", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await sendAccountRpc(origin, accountId, "bot.update", {
		botId: "echo-bot",
		tools: ["memory_read", "memory_update", "knowledge_read"],
		toolsEnv: { enabled: false },
	});
	await page.goto("/bot/echo-bot/tools");
	await expect(toolSwitch(page, "memory_update")).toHaveAttribute(
		"data-state",
		"checked",
	);
	await clickSwitch(page, "Read-only mode");
	const readonly = knownReadOnlyToolNames(availableAllowlistNames(false));
	for (const name of readonly) {
		await expect(toolSwitch(page, name)).toHaveAttribute(
			"data-state",
			"checked",
		);
	}
	await expect(toolSwitch(page, "memory_update")).toHaveAttribute(
		"data-state",
		"unchecked",
	);
	await expect(toolSwitch(page, "search_bot")).toHaveAttribute(
		"data-state",
		"unchecked",
	);
	await clickSwitch(page, "Read-only mode");
	await expect(toolSwitch(page, "memory_update")).toHaveAttribute(
		"data-state",
		"checked",
	);
	await expect(toolSwitch(page, "knowledge_update")).toHaveAttribute(
		"data-state",
		"unchecked",
	);
	await clickByRole(page, "button", "Save");
	await expect
		.poll(async () =>
			(await getBot(origin, accountId, "echo-bot")).tools?.sort(),
		)
		.toEqual(["knowledge_read", "memory_read", "memory_update"].sort());
	await clickSwitch(page, "Read-only mode");
	await expect(toolSwitch(page, "memory_update")).toHaveAttribute(
		"data-state",
		"unchecked",
	);
	await clickByRole(page, "button", "Save");
	await expect
		.poll(async () =>
			(await getBot(origin, accountId, "echo-bot")).tools?.sort(),
		)
		.toEqual([...readonly].sort());
	await page.reload();
	await expect(toolSwitch(page, "Read-only mode")).toHaveAttribute(
		"data-state",
		"checked",
	);
	await expect(toolSwitch(page, "memory_update")).toHaveAttribute(
		"data-state",
		"unchecked",
	);
});

test("delete bot confirms and leaves the main list", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	const posts = await watchPosts(page);
	await page.goto("/bot/echo-bot/config");
	await clickByRole(page, "button", "Delete bot");
	await expect(
		page.getByText(
			"This also deletes all of its chats, files and schedules. This can't be undone.",
		),
	).toBeVisible();
	await clickByRole(page, "button", "Delete Echo Bot");
	await expect(page.getByRole("heading", { name: "Cadmus" })).toBeVisible();
	await expect(page.getByRole("region", { name: "Echo Bot" })).toHaveCount(0);
	expect(
		(await posts.all()).some((hit) => hit.url.includes("/api/bot/delete")),
	).toBe(true);
});

/** Record `window.confirm` and choose the answer. Obscura drops textarea `.value`. */
async function installConfirm(page: Page, accept = false): Promise<void> {
	await page.addInitScript((acceptByDefault) => {
		const bag = window as unknown as {
			__confirms?: string[];
			__acceptConfirm?: boolean;
		};
		bag.__confirms = [];
		bag.__acceptConfirm = acceptByDefault;
		window.confirm = (message?: string) => {
			bag.__confirms?.push(String(message ?? ""));
			return bag.__acceptConfirm === true;
		};
	}, accept);
}

async function confirms(page: Page): Promise<string[]> {
	return page.evaluate(
		() => (window as unknown as { __confirms?: string[] }).__confirms ?? [],
	);
}

async function setConfirmAccept(page: Page, accept: boolean): Promise<void> {
	await page.evaluate((next) => {
		(window as unknown as { __acceptConfirm?: boolean }).__acceptConfirm = next;
	}, accept);
}

test("soul and memory edit with no typing stays clean", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await sendAccountRpc(origin, accountId, "file.write", {
		botId: "echo-bot",
		path: "SOUL.md",
		content: "# Soul\n\nCalm.",
	});
	await sendAccountRpc(origin, accountId, "file.write", {
		botId: "echo-bot",
		path: "MEMORY.md",
		content: "# Memory\n\nDark roast.",
	});
	await installConfirm(page);
	await page.goto("/bot/echo-bot/soul");
	await expect(
		page.getByRole("heading", { name: "Soul", level: 1 }),
	).toBeVisible();
	await expect(page.getByText("Unsaved changes")).toHaveCount(0);
	await clickByRole(page, "button", "Edit");
	await expect(page.getByRole("button", { name: "Save" })).toBeVisible();
	await expect(page.getByText("Unsaved changes")).toHaveCount(0);
	await clickByRole(page, "radio", "Memory");
	await expect(
		page.getByRole("heading", { name: "Memory", level: 1 }),
	).toBeVisible();
	await expect(page.getByText("Unsaved changes")).toHaveCount(0);
	await clickByRole(page, "button", "Edit");
	await expect(page.getByRole("button", { name: "Save" })).toBeVisible();
	await expect(page.getByText("Unsaved changes")).toHaveCount(0);
	await clickByRole(page, "radio", "Schedules");
	await expect(
		page.getByRole("button", { name: "New schedule" }),
	).toBeVisible();
	expect(await confirms(page)).toEqual([]);
});

/** TanStack History blocks unload only when `enableBeforeUnload` returns true. */
async function beforeUnloadBlocked(page: Page): Promise<boolean> {
	return page.evaluate(() => {
		const event = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(event);
		return event.defaultPrevented;
	});
}

test("beforeunload warns only while soul edits differ from baseline", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await sendAccountRpc(origin, accountId, "file.write", {
		botId: "echo-bot",
		path: "SOUL.md",
		content: "# Soul\n\nCalm.",
	});
	await page.goto("/bot/echo-bot/soul");
	await expect(
		page.getByRole("heading", { name: "Soul", level: 1 }),
	).toBeVisible();
	expect(await beforeUnloadBlocked(page)).toBe(false);
	await clickByRole(page, "button", "Edit");
	await expect(page.getByRole("button", { name: "Save" })).toBeVisible();
	expect(await beforeUnloadBlocked(page)).toBe(false);
	await fillByLabel(page, "SOUL.md source", "# Soul\n\nRestless.");
	await expect(page.getByText("Unsaved changes")).toBeVisible();
	expect(await beforeUnloadBlocked(page)).toBe(true);
	await fillByLabel(page, "SOUL.md source", "# Soul\n\nCalm.");
	await expect(page.getByText("Unsaved changes")).toHaveCount(0);
	expect(await beforeUnloadBlocked(page)).toBe(false);
	await page.reload();
	await expect(
		page.getByRole("heading", { name: "Soul", level: 1 }),
	).toBeVisible();
	expect(await beforeUnloadBlocked(page)).toBe(false);
});

test("memory edit prompts only for real changes and clears when reverted or saved", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await sendAccountRpc(origin, accountId, "file.write", {
		botId: "echo-bot",
		path: "MEMORY.md",
		content: "# Memory\n\nDark roast.",
	});
	await sendAccountRpc(origin, accountId, "file.write", {
		botId: "echo-bot",
		path: "knowledge/heating.md",
		content: "# Heating\n\nZones.",
		description: "Heating zones",
	});
	await installConfirm(page, false);
	await page.goto("/bot/echo-bot/memory");
	await clickByRole(page, "button", "Edit");
	await fillByLabel(page, "MEMORY.md source", "# Memory\n\nLight roast.");
	await expect(page.getByText("Unsaved changes")).toBeVisible();
	await clickByRole(page, "radio", "Soul");
	await expect(page.getByRole("button", { name: "Save" })).toBeVisible();
	await expect(page.getByText("Unsaved changes")).toBeVisible();
	expect(await confirms(page)).toEqual(["Discard unsaved changes?"]);
	await fillByLabel(page, "MEMORY.md source", "# Memory\n\nDark roast.");
	await expect(page.getByText("Unsaved changes")).toHaveCount(0);
	await clickByRole(page, "radio", "Soul");
	await expect(page.getByText("SOUL.md")).toBeVisible();
	expect(await confirms(page)).toEqual(["Discard unsaved changes?"]);
	await clickByRole(page, "radio", "Memory");
	await clickByRole(page, "button", "Edit");
	await fillByLabel(page, "MEMORY.md source", "# Memory\n\nLight roast.");
	await setConfirmAccept(page, true);
	await clickByRole(page, "radio", "Knowledge");
	await expect(
		page.getByRole("button", { name: /heating \d+ bytes/ }),
	).toBeVisible();
	expect(await confirms(page)).toEqual([
		"Discard unsaved changes?",
		"Discard unsaved changes?",
	]);
	await page.getByRole("button", { name: /heating \d+ bytes/ }).click();
	await expect(page.getByRole("button", { name: "Edit" })).toBeVisible();
	await expect(page.getByText("Unsaved changes")).toHaveCount(0);
	await clickByRole(page, "button", "Edit");
	await expect(page.getByText("Unsaved changes")).toHaveCount(0);
	await page.goBack();
	await expect(
		page.getByRole("button", { name: /heating \d+ bytes/ }),
	).toBeVisible();
});

test("memory save clears dirty and a failed save keeps it", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await sendAccountRpc(origin, accountId, "file.write", {
		botId: "echo-bot",
		path: "MEMORY.md",
		content: "# Memory\n\nDark roast.",
	});
	await installConfirm(page);
	let failWrite = true;
	await page.route("**/api/file/write**", async (route) => {
		if (!failWrite) {
			await route.continue();
			return;
		}
		await route.fulfill({
			status: 409,
			contentType: "application/json",
			body: JSON.stringify({
				error: { code: "conflict", message: "Version conflict" },
			}),
		});
	});
	await page.goto("/bot/echo-bot/memory");
	await clickByRole(page, "button", "Edit");
	await fillByLabel(page, "MEMORY.md source", "# Memory\n\nLight roast.");
	await clickByRole(page, "button", "Save");
	await expect(page.getByRole("alert")).toHaveText("Version conflict");
	await expect(page.getByText("Unsaved changes")).toBeVisible();
	await expect(page.getByRole("button", { name: "Save" })).toBeVisible();
	await setConfirmAccept(page, true);
	await clickByRole(page, "button", "Cancel");
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect(page.getByText("Unsaved changes")).toHaveCount(0);
	await clickByRole(page, "button", "Edit");
	await expect(page.getByRole("alert")).toHaveCount(0);
	await fillByLabel(page, "MEMORY.md source", "# Memory\n\nLight roast.");
	await clickByRole(page, "button", "Save");
	await expect(page.getByRole("alert")).toHaveText("Version conflict");
	await setConfirmAccept(page, true);
	await clickByRole(page, "radio", "Soul");
	await expect(page.getByText("SOUL.md")).toBeVisible();
	await expect(page.getByRole("alert")).toHaveCount(0);
	await clickByRole(page, "radio", "Memory");
	await clickByRole(page, "button", "Edit");
	await fillByLabel(page, "MEMORY.md source", "# Memory\n\nLight roast.");
	failWrite = false;
	await clickByRole(page, "button", "Save");
	await expect(page.getByRole("button", { name: "Edit" })).toBeVisible();
	await expect(page.getByText("Unsaved changes")).toHaveCount(0);
	await clickByRole(page, "radio", "Soul");
	await expect(page.getByText("SOUL.md")).toBeVisible();
	expect(await confirms(page)).toEqual([
		"Discard unsaved changes?",
		"Discard unsaved changes?",
	]);
});

test("slow soul load does not mark dirty before or after edit", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await sendAccountRpc(origin, accountId, "file.write", {
		botId: "echo-bot",
		path: "SOUL.md",
		content: "# Soul\n\nCalm.",
	});
	await installConfirm(page);
	let releaseRead: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		releaseRead = resolve;
	});
	await page.route("**/api/file/read**", async (route) => {
		await gate;
		await route.continue();
	});
	await page.goto("/bot/echo-bot/soul");
	await expect(
		page.getByRole("status", { name: "Loading SOUL.md" }),
	).toBeVisible();
	await expect(page.getByText("Unsaved changes")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);
	releaseRead?.();
	await expect(
		page.getByRole("heading", { name: "Soul", level: 1 }),
	).toBeVisible();
	await expect(page.getByText("Unsaved changes")).toHaveCount(0);
	await clickByRole(page, "button", "Edit");
	await expect(page.getByRole("button", { name: "Save" })).toBeVisible();
	await expect(page.getByText("Unsaved changes")).toHaveCount(0);
	await clickByRole(page, "radio", "Memory");
	await expect(page.getByText("MEMORY.md")).toBeVisible();
	expect(await confirms(page)).toEqual([]);
});

test("memory edit writes and knowledge delete removes a doc", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await sendAccountRpc(origin, accountId, "file.write", {
		botId: "echo-bot",
		path: "knowledge/heating.md",
		content: "# Heating\n\nZones.",
		description: "Heating zones",
	});
	const posts = await watchPosts(page);
	await page.goto("/bot/echo-bot/memory");
	await clickByRole(page, "button", "Edit");
	await fillByLabel(page, "MEMORY.md source", "# Memory\n\nDark roast.");
	await expect(page.getByText("Unsaved changes")).toBeVisible();
	await clickByRole(page, "button", "Save");
	await expect
		.poll(async () =>
			(await posts.all()).some(
				(hit) =>
					hit.url.includes("/api/file/write") &&
					hit.body.includes("Dark roast."),
			),
		)
		.toBe(true);
	await page.goto("/bot/echo-bot/knowledge");
	await expect(
		page.getByRole("button", { name: /heating \d+ bytes/ }),
	).toBeVisible();
	await clickByRole(page, "button", "Delete heating");
	await expect
		.poll(async () =>
			(await posts.all()).some(
				(hit) =>
					hit.url.includes("/api/file/delete") &&
					hit.body.includes("knowledge/heating.md"),
			),
		)
		.toBe(true);
	await expect(page.getByText("No knowledge docs.")).toBeVisible();
});

test("schedule toggle sends schedule.update", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	const created = await sendAccountRpc<{ schedule: { id: string } }>(
		origin,
		accountId,
		"schedule.create",
		{
			botId: "echo-bot",
			name: "Morning climate check",
			kind: "cron",
			input: "0 7 * * *",
			text: "Check the climate.",
			target: { mode: "new-chat" },
		},
	);
	const posts = await watchPosts(page);
	await page.goto("/bot/echo-bot/schedules");
	await expect(
		page.getByRole("button", { name: "Morning climate check" }),
	).toBeVisible();
	await page
		.getByRole("switch", { name: "Pause Morning climate check" })
		.evaluate((node) => {
			(node as HTMLElement).click();
		});
	await expect
		.poll(async () =>
			(await posts.all()).some(
				(hit) =>
					hit.url.includes("/api/schedule/update") &&
					hit.body.includes(created.schedule.id) &&
					hit.body.includes('"enabled":false'),
			),
		)
		.toBe(true);
});

test("harvest note appears and the chat toggle updates harvest", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await sendAccountRpc(origin, accountId, "family.update", {
		harvestDelayMs: 200,
	});
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	const created = await sendAccountRpc<{ chat: { key: string } }>(
		origin,
		accountId,
		"chat.create",
		{ botId: "echo-bot", title: "Tune thermostat schedules" },
	);
	await sendAccountRpc(origin, accountId, "turn.submit", {
		chatKey: created.chat.key,
		text: "Hello [remember: kids room lights off at 20:00]",
	});
	const posts = await watchPosts(page);
	await page.goto("/bot/echo-bot/harvest");
	await expect(page.getByRole("heading", { name: "Harvest" })).toBeVisible();
	await expect(page.getByText("Tune thermostat schedules")).toBeVisible({
		timeout: 30_000,
	});
	await expect(page.getByText("MEMORY.md +1").first()).toBeVisible();
	await page.getByRole("switch", { name: "Harvest on" }).evaluate((node) => {
		(node as HTMLElement).click();
	});
	await expect
		.poll(async () =>
			(await posts.all()).some(
				(hit) =>
					hit.url.includes("/api/chat/update") &&
					hit.body.includes('"harvest":false'),
			),
		)
		.toBe(true);
});

test("group menu opens profile, archives chats, and sets colour", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await sendAccountRpc(origin, accountId, "chat.create", {
		botId: "echo-bot",
		title: "Morning notes",
	});
	const posts = await watchPosts(page);
	await page.goto("/");
	await expect(
		page.getByRole("button", { name: "Morning notes", exact: true }),
	).toBeVisible();
	await clickByRole(page, "button", "Echo Bot menu");
	await clickByRole(page, "button", "Profile");
	await expect(page.getByRole("radio", { name: "Schedules" })).toBeVisible();
	await page.goto("/");
	await clickByRole(page, "button", "Echo Bot menu");
	await clickByRole(page, "button", "Change colour");
	await clickByRole(page, "button", "bot-3");
	await expect
		.poll(async () =>
			(await posts.all()).some(
				(hit) =>
					hit.url.includes("/api/bot/update") &&
					hit.body.includes('"color":"bot-3"'),
			),
		)
		.toBe(true);
	await clickByRole(page, "button", "Echo Bot menu");
	await clickByRole(page, "button", "Archive all chats");
	await clickByRole(page, "button", "Archive all");
	await expect(
		page.getByRole("button", { name: "Morning notes", exact: true }),
	).toHaveCount(0);
});
