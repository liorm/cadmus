import { existsSync, readFileSync } from "node:fs";
import {
	type Browser,
	test as base,
	type Page,
	type Request,
} from "@playwright/test";
import {
	MASTER_TOKEN,
	provisionAccount,
	retryProxyDrop,
	sendAccountRpc,
	throwOnProxyDrop,
	uniqueAccountId,
} from "./account.ts";
import { captureCoverage } from "./coverage.ts";
import {
	CDP_URL_FILE,
	cdpUrlFromEnv,
	isPerWorkerEngine,
	parseEngine,
	startEngineOnPort,
} from "./engine.ts";

function cdpUrl(): string | undefined {
	if (process.env.CADMUS_TEST_CDP_URL) return process.env.CADMUS_TEST_CDP_URL;
	if (existsSync(CDP_URL_FILE)) {
		return readFileSync(CDP_URL_FILE, "utf8").trim() || undefined;
	}
	return undefined;
}

const WORKER_BASE = "http://127.0.0.1:8799";

/**
 * The dev worker budgets credential routes per cf-connecting-ip, and every
 * test here reaches it from the same loopback address, so the whole suite
 * shares one budget (20 per minute on /auth/token-login). Each test gets its
 * own source address so tests do not spend each other's budget. Production is
 * unaffected: these headers exist only in the test run. Whether the real edge
 * replaces a client-sent value is relied on but not verified (see the comment in
 * worker/src/auth-limiter.ts). The budget stays on; auth-budget.spec.ts proves it.
 */
export function sourceAddressFor(testId: string, retry: number): string {
	let h = 2166136261;
	for (const ch of `${testId}:${retry}`) {
		h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
	}
	return `10.${(h >>> 16) & 255}.${(h >>> 8) & 255}.${h & 255}`;
}

/**
 * Grants of the `user` role (worker contract ROLE_GRANTS.user, pinned by the
 * golden in worker/tests/unit/authz-registry-matrix.test.ts). A "user" session
 * below is a token-login session clamped to exactly these grants. It cannot
 * enter admin mode (API tokens cannot manage sessions), so specs whose subject
 * is admin mode, passkey step-up or a real session use support/fresh-session.ts
 * instead of this option.
 */
// Must equal ROLE_GRANTS.user in the contract; packages/worker/tests/user-role-grants-fixture.test.ts checks it.
export const USER_ROLE_GRANTS = [
	"chat.use",
	"bot.read",
	"bot.write",
	"knowledge.write",
	"schedule.write",
	"files.write",
	"members.read",
	"credentials.read",
	"toolsEnv.read",
	"tokens.self",
	"session.assume",
];

type ConfigState =
	| "absent"
	| "master"
	| "other-token"
	| "no-token"
	| "malformed";

/** Classify the stored dev config by what it holds, not by whether it exists. */
function classifyConfig(raw: string | null): ConfigState {
	if (raw === null) return "absent";
	try {
		const parsed = JSON.parse(raw) as { token?: unknown } | null;
		const token = typeof parsed?.token === "string" ? parsed.token.trim() : "";
		if (token === "") return "no-token";
		return token === MASTER_TOKEN ? "master" : "other-token";
	} catch {
		return "malformed";
	}
}

/** Reads `cadmus.dev.config` from a page with a bounded timeout for teardown safety. */
async function readStoredDevConfig(
	target: Page,
): Promise<ConfigState | undefined> {
	if (target.isClosed()) return undefined;
	try {
		const raw = await Promise.race([
			target.evaluate(() => window.localStorage.getItem("cadmus.dev.config")),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("readConfig timeout")), 5_000),
			),
		]);
		return classifyConfig(raw);
	} catch {
		return undefined;
	}
}

/**
 * How the browser signs in. "user" (default) signs in through /auth/token-login
 * with a PAT holding the user-role grants and seeds no master token, so the page
 * only works through the session cookie. "master" seeds the dev master token
 * into localStorage (the legacy path phase 9 removes); specs that still need
 * those grants opt in. "none" seeds no master token and signs in nothing: the
 * spec does its own sign-in (or none), and the fixture only proves that no
 * master dev config reached storage and, where request headers are observable,
 * that no page request carried the master bearer. It does not require a token
 * session.
 */
export type SignInMode = "master" | "user" | "none";

export const test = base.extend<
	{ accountId: string; signIn: SignInMode },
	{ browser: Browser }
>({
	signIn: ["user", { option: true }],
	extraHTTPHeaders: async ({ browserName: _b }, use, info) => {
		await use({
			"cf-connecting-ip": sourceAddressFor(info.testId, info.retry),
		});
	},
	page: async ({ page }, use, info) => {
		await use(page);
		await captureCoverage(page, info.testId);
	},
	accountId: [
		async ({ baseURL, page, signIn }, use, info) => {
			const accountId = uniqueAccountId();
			await provisionAccount(baseURL ?? WORKER_BASE, accountId);
			if (signIn === "none") {
				const context = page.context();
				const configSeen: ConfigState[] = [];
				const pageReqs: Request[] = [];
				const respondedReqs = new WeakSet<Request>();
				let pageRequests = 0;
				let headerSeen = 0;
				const masterBearerRequests = new Set<string>();
				context.on("request", (req) => {
					const path = new URL(req.url()).pathname;
					if (
						!path.startsWith("/api/") &&
						!path.startsWith("/rpc") &&
						!path.startsWith("/auth/")
					) {
						return;
					}
					pageReqs.push(req);
				});
				// allHeaders() never resolves for a request with no response, so only a
				// request that got a response is read with it; every other request uses
				// its synchronous snapshot, which carries the authorization header.
				context.on("response", (res) => respondedReqs.add(res.request()));
				// The app itself writes the non-secret selection fields to this key when
				// the family is switched, so the key being present is not a finding.
				// What is checked is the stored token: only the dev master token is.
				const read = readStoredDevConfig;
				const watch = (target: Page) =>
					target.on("load", async () => {
						const seen = await read(target);
						if (seen !== undefined) configSeen.push(seen);
					});
				watch(page);
				context.on("page", watch);
				// A failing test body does not throw through use(): Playwright records it
				// and still runs this teardown, so a proof problem is reported as its own
				// error next to the body failure.
				await use(accountId);
				const problems: string[] = [];
				const finalReads = await Promise.all(
					context.pages().map((p) => read(p)),
				);
				if (finalReads.some((r) => r === "master")) {
					problems.push(
						"the master token is stored in the dev config at teardown",
					);
				}
				if (configSeen.some((r) => r === "master")) {
					problems.push(
						`the master token was stored in the dev config after load: ${JSON.stringify(configSeen)}`,
					);
				}
				await Promise.all(
					pageReqs.map(async (req) => {
						pageRequests += 1;
						let all: Record<string, string> = {};
						try {
							all = respondedReqs.has(req)
								? await req.allHeaders()
								: req.headers();
						} catch {
							return;
						}
						if (Object.keys(all).length > 0) headerSeen += 1;
						if (all.authorization?.replace(/^Bearer\s+/i, "") === MASTER_TOKEN)
							masterBearerRequests.add(
								`${req.method()} ${new URL(req.url()).pathname}`,
							);
					}),
				);
				if (headerSeen > 0) {
					// Not asserted: before phase 9 a signed-out page uses the default
					// client token, so a master bearer on a page request is expected for
					// specs that show a signed-out page. The requests are recorded.
					info.annotations.push({
						type: "no-seed-proof-master-bearer-not-asserted",
						description: `${headerSeen} of ${pageRequests} page requests exposed headers; requests with the master bearer: ${JSON.stringify([...masterBearerRequests].sort())}`,
					});
				} else {
					info.annotations.push({
						type: "no-seed-proof-headers-unobservable",
						description: `0 of ${pageRequests} page requests exposed any header; master-bearer request list not available; config reads ${JSON.stringify(configSeen)} final ${JSON.stringify(finalReads)}`,
					});
				}
				const stored = [...configSeen, ...finalReads].filter(
					(r) => r !== undefined && r !== "absent",
				);
				if (stored.length > 0) {
					info.annotations.push({
						type: "no-seed-proof-config-states",
						description: `non-master config states seen: ${JSON.stringify([...new Set(stored)].sort())}`,
					});
				}
				if (problems.length > 0) {
					throw new Error(`no-seed proof: ${problems.join("; ")}`);
				}
				return;
			}
			if (signIn === "user") {
				const origin = baseURL ?? WORKER_BASE;
				const created = await sendAccountRpc<{ token: string }>(
					origin,
					accountId,
					"auth.tokens.create",
					{
						kind: "pat",
						label: "ui user session",
						grants: USER_ROLE_GRANTS,
						ttlDays: 1,
					},
				);
				await retryProxyDrop(async () => {
					const login = await page
						.context()
						.request.post(`${origin}/auth/token-login`, {
							headers: { Authorization: `Bearer ${created.token}` },
						});
					if (login.ok()) return;
					const loginStatus = login.status();
					const text = await login.text().catch(() => "");
					throwOnProxyDrop(loginStatus, text);
					throw new Error(`token-login failed: ${loginStatus}`);
				});
				// Passive proof, no extra requests: record what the page itself sends.
				// No page request may carry the master bearer, at least one must carry
				// another bearer, the dev config must be absent after every load, and
				// the page's own whoami answer must be the token session. Master RPC
				// above and in specs is setup only.
				const context = page.context();
				const bearers = new Set<string>();
				type WhoamiOutcome =
					| { kind: "ok"; principal: { viaToken?: boolean } | null | undefined }
					| { kind: "bad-status"; status: number }
					| { kind: "bad-json"; error: string }
					| { kind: "nav-aborted" };
				const readWhoamiOutcome = async (
					res: import("@playwright/test").Response,
				): Promise<WhoamiOutcome> => {
					if (!res.ok()) {
						return { kind: "bad-status", status: res.status() };
					}
					let text: string;
					try {
						text = await res.text();
					} catch {
						// Navigating immediately after load/render (e.g. csp or fast /new->/)
						// can evict the CDP response body of an in-flight /api/auth/whoami.
						return { kind: "nav-aborted" };
					}
					try {
						const body = JSON.parse(text) as {
							result?: { principal?: { viaToken?: boolean } | null };
							principal?: { viaToken?: boolean } | null;
						};
						return {
							kind: "ok",
							principal: body.result?.principal ?? body.principal ?? null,
						};
					} catch (error) {
						return {
							kind: "bad-json",
							error: error instanceof Error ? error.message : String(error),
						};
					}
				};
				const whoami: Array<Promise<WhoamiOutcome>> = [];
				const whoamiReqs: Request[] = [];
				const configSeen: Array<ConfigState | undefined> = [];
				const pageReqs: Request[] = [];
				const respondedReqs = new WeakSet<Request>();
				let pageRequests = 0;
				let headerSeen = 0;
				// Context level, so popups and other pages are covered. A websocket
				// ticket URL is not a bearer claim and is not inspected here.
				context.on("request", (req) => {
					const path = new URL(req.url()).pathname;
					if (
						!path.startsWith("/api/") &&
						!path.startsWith("/rpc") &&
						!path.startsWith("/auth/")
					) {
						return;
					}
					pageReqs.push(req);
					if (path === "/api/auth/whoami") whoamiReqs.push(req);
				});
				// allHeaders() never resolves for a request that has no response (still
				// pending, or cancelled before one arrived), so only a request that got a
				// response is read with it; every other request uses its synchronous
				// snapshot, which carries the authorization header.
				context.on("response", (res) => respondedReqs.add(res.request()));
				context.on("response", (res) => {
					if (new URL(res.url()).pathname !== "/api/auth/whoami") return;
					whoami.push(readWhoamiOutcome(res));
				});
				// The app writes the non-secret selection fields to this key when the family
				// is switched, so the key existing is not a finding. A token stored in it is.
				const readConfig = readStoredDevConfig;
				const watch = (target: Page) =>
					target.on("load", async () => {
						const seen = await readConfig(target);
						if (seen !== undefined) configSeen.push(seen);
					});
				watch(page);
				context.on("page", watch);
				// A failing test body does not throw through use(): Playwright records it
				// and still runs this teardown, so a proof problem is reported as its own
				// error next to the body failure.
				await use(accountId);
				const problems: string[] = [];
				// A closed or unreadable page is reported, never treated as a pass.
				const finalReads = await Promise.all(
					context.pages().map((p) => readConfig(p)),
				);
				const holdsToken = (r: ConfigState | undefined) =>
					r === "master" || r === "other-token";
				if (finalReads.some(holdsToken)) {
					problems.push("a token is stored in the dev config at teardown");
				}
				if (
					finalReads.length === 0 ||
					finalReads.every((r) => r === undefined)
				) {
					// Native-close specs end with every page closed on purpose. The
					// load-time reads above still have to have succeeded; the skipped
					// final read is recorded, not hidden.
					info.annotations.push({
						type: "user-sign-in-proof-final-read",
						description: `skipped: no open page at teardown; load-time reads ${JSON.stringify(configSeen)}`,
					});
				}
				info.annotations.push({
					type: "user-sign-in-proof-config-states",
					description: `load-time reads ${JSON.stringify(configSeen)} final ${JSON.stringify(finalReads)}`,
				});
				if (configSeen.length === 0 || configSeen.some(holdsToken)) {
					problems.push(
						`a token was stored in the dev config after load: ${JSON.stringify(configSeen)}`,
					);
				}
				await Promise.all(
					pageReqs.map(async (req) => {
						pageRequests += 1;
						let all: Record<string, string> = {};
						try {
							all = respondedReqs.has(req)
								? await req.allHeaders()
								: req.headers();
						} catch {
							return;
						}
						if (Object.keys(all).length > 0) headerSeen += 1;
						const auth = all.authorization;
						if (auth) bearers.add(auth.replace(/^Bearer\s+/i, ""));
					}),
				);
				if (headerSeen > 0) {
					if (bearers.has(MASTER_TOKEN)) {
						problems.push("a page request carried the master bearer");
					}
					if ([...bearers].filter((b) => b !== MASTER_TOKEN).length === 0) {
						problems.push("no page request carried a non-master bearer");
					}
				} else {
					// Some engines (obscura) expose no request headers at all, so a
					// bearer check would pass or fail vacuously. Record that, and rely
					// on the whoami token-session proof and the absent dev config.
					info.annotations.push({
						type: "user-sign-in-proof-headers-unobservable",
						description: `0 of ${pageRequests} page requests exposed any header; bearer check not performed`,
					});
				}
				let outcomes = await Promise.all(whoami);
				const needsLiveWhoami = () =>
					outcomes.length === 0 ||
					outcomes.every((o) => o.kind === "nav-aborted");
				if (needsLiveWhoami() && !page.isClosed()) {
					const pending = whoamiReqs.filter((req) => !respondedReqs.has(req));
					if (pending.length > 0) {
						await Promise.race([
							Promise.all(
								pending.map(async (req) => {
									try {
										const res = await req.response();
										if (!res) return;
										whoami.push(readWhoamiOutcome(res));
									} catch {
										/* request aborted or page closed */
									}
								}),
							),
							new Promise((resolve) => setTimeout(resolve, 5_000)),
						]);
					} else {
						await page
							.waitForResponse(
								(res) => new URL(res.url()).pathname === "/api/auth/whoami",
								{ timeout: 5_000 },
							)
							.catch(() => undefined);
					}
					outcomes = await Promise.all(whoami);
				}
				const badOutcomes = outcomes.filter(
					(o) =>
						o.kind === "bad-status" ||
						o.kind === "bad-json" ||
						(o.kind === "ok" && o.principal?.viaToken !== true),
				);
				const okOutcomes = outcomes.filter((o) => o.kind === "ok");
				if (outcomes.length === 0) {
					problems.push("the page made no whoami request");
				} else if (badOutcomes.length > 0 || okOutcomes.length === 0) {
					problems.push(
						`page whoami was unreadable or not the token session: ${JSON.stringify(outcomes)}`,
					);
				}
				const listed = await sendAccountRpc<{
					tokens: Array<{ label: string; grants?: string[] }>;
				}>(origin, accountId, "auth.tokens.list", {});
				const mine = listed.tokens.find((t) => t.label === "ui user session");
				if (
					!mine ||
					JSON.stringify([...(mine.grants ?? [])].sort()) !==
						JSON.stringify([...USER_ROLE_GRANTS].sort())
				) {
					problems.push(`minted grants differ: ${JSON.stringify(mine)}`);
				}
				if (problems.length > 0) {
					throw new Error(`user sign-in proof: ${problems.join("; ")}`);
				}
				return;
			}
			await page.addInitScript(
				(cfg) => {
					localStorage.setItem("cadmus.dev.config", JSON.stringify(cfg));
				},
				{
					accountId,
					userId: "owner",
					familyId: "default",
					token: MASTER_TOKEN,
				},
			);
			await use(accountId);
		},
		{ auto: true },
	],
	// Worker-scoped so we never touch Playwright's built-in `browser` fixture.
	// That fixture launches a local Chromium before the test body runs.
	browser: [
		async ({ playwright, launchOptions }, use, workerInfo) => {
			const engine = parseEngine();
			if (engine === "chrome") {
				const launched = await playwright.chromium.launch(launchOptions);
				await use(launched);
				await launched.close();
				return;
			}
			const explicitEnvCdp = cdpUrlFromEnv();
			if (!explicitEnvCdp && isPerWorkerEngine(engine)) {
				const port = 9222 + workerInfo.parallelIndex;
				const handle = await startEngineOnPort(engine, port);
				try {
					if (!handle.cdpUrl) {
						throw new Error(`CDP URL missing for ${engine} on port ${port}.`);
					}
					const connected = await playwright.chromium.connectOverCDP(
						handle.cdpUrl,
					);
					try {
						await use(connected);
					} finally {
						await connected.close();
					}
				} finally {
					await handle.stop();
				}
				return;
			}
			const cdp = cdpUrl();
			if (!cdp) {
				throw new Error(
					"CDP URL missing. Start Obscura or Lightpanda, or pass --engine=chrome.",
				);
			}
			const connected = await playwright.chromium.connectOverCDP(cdp);
			await use(connected);
			await connected.close();
		},
		{ scope: "worker", timeout: 0 },
	],
});

export { expect } from "@playwright/test";
