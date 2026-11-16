import type { Page } from "@playwright/test";
import { parseEngine } from "./engine.ts";

/**
 * True when two pages of one browser context really exchange BroadcastChannel
 * messages. Some engines (obscura) expose the API but never deliver across
 * pages, so multi-tab behavior can only be checked on engines that do. The
 * probe uses two throwaway pages on a static same-origin JSON route, so it
 * never boots the app or touches the session.
 *
 * Only the known non-delivering engine (obscura) may skip. On every other
 * engine, including real Chrome, a failed probe is an error (bounded 5s wait),
 * so the cross-tab security coverage cannot silently turn green.
 */
export async function crossTabMessagingWorks(page: Page): Promise<boolean> {
	const name = `probe-${Math.random().toString(36).slice(2)}`;
	const listener = await page.context().newPage();
	const sender = await page.context().newPage();
	try {
		await listener.goto("/auth/providers");
		await sender.goto("/auth/providers");
		await listener.evaluate((n) => {
			const w = window as unknown as { probeGot: unknown[]; probe: unknown };
			w.probeGot = [];
			const channel = new BroadcastChannel(n);
			channel.onmessage = (event) => w.probeGot.push(event.data);
			w.probe = channel;
		}, name);
		await sender.evaluate((n) => {
			new BroadcastChannel(n).postMessage("ping");
		}, name);
		for (let i = 0; i < 50; i++) {
			const got = await listener.evaluate(
				() => (window as unknown as { probeGot: unknown[] }).probeGot.length,
			);
			if (got > 0) return true;
			await listener.waitForTimeout(100);
		}
		if (parseEngine() !== "obscura") {
			throw new Error(
				`cross-tab BroadcastChannel probe failed on engine ${parseEngine()}`,
			);
		}
		return false;
	} finally {
		await listener.close();
		await sender.close();
	}
}

/**
 * True when navigator.locks really serializes holders of one lock name. The
 * app relies on it so tabs of one browser never present the same rotating
 * refresh cookie at once (a second presenter looks like reuse and revokes the
 * session). Obscura exposes the API but lets a second holder run while the
 * first still holds the lock, so two tabs racing a refresh can revoke each
 * other there. Only obscura may skip; any other engine must serialize or the
 * run fails.
 */
export async function webLocksSerialize(page: Page): Promise<boolean> {
	const probe = await page.context().newPage();
	try {
		await probe.goto("/auth/providers");
		const order = await probe.evaluate(async () => {
			const locks = (
				navigator as unknown as {
					locks?: {
						request: (
							name: string,
							cb: () => Promise<number>,
						) => Promise<number>;
					};
				}
			).locks;
			if (!locks) return "missing";
			const seen: number[] = [];
			const first = locks.request("probe-serialize", async () => {
				await new Promise((resolve) => setTimeout(resolve, 300));
				seen.push(1);
				return 1;
			});
			const second = locks.request("probe-serialize", async () => {
				seen.push(2);
				return 2;
			});
			await Promise.all([first, second]);
			return seen.join(",");
		});
		if (order === "1,2") return true;
		if (parseEngine() !== "obscura") {
			throw new Error(
				`navigator.locks does not serialize on engine ${parseEngine()}: ${order}`,
			);
		}
		return false;
	} finally {
		await probe.close();
	}
}
