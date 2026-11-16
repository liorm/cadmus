/**
 * Role/label helpers. Playwright locators first; evaluate fallbacks for
 * engines where locator click/fill time out (obscura#45).
 */
import { expect, type Locator, type Page } from "@playwright/test";

/** Open a timezone combobox, filter, and choose `zone` (keyboard or click). */
export async function chooseTimezone(
	page: Page,
	label: string,
	zone: string,
	mode: "keyboard" | "click" = "keyboard",
): Promise<void> {
	const input = page.getByRole("combobox", { name: label });
	await input.click();
	await input.fill(zone);
	if (mode === "click") {
		await page.getByRole("option", { name: zone, exact: true }).click();
	} else {
		await input.press("ArrowDown");
		await input.press("Enter");
	}
	await expect(page.getByRole("combobox", { name: label })).toHaveValue(zone);
}

/**
 * True only for an error that proves the click never dispatched. Playwright
 * puts the click's call log in the error message: a timeout that logged
 * "performing click action" (or "click action done") reached the dispatch
 * stage, so repeating the click could act twice. Unknown error shapes are not
 * pre-dispatch: the helper rethrows them.
 *
 * Shapes observed on Playwright 1.64.1 with the Obscura engine:
 * - missing element: "locator.click: Timeout Nms exceeded." with a call log
 *   that stops at "waiting for getByRole(...)";
 * - covered element: the same timeout with "intercepts pointer events" and
 *   "retrying click action" lines and no "performing click action";
 *
 * An ambiguous locator ("strict mode violation") is not handled here: it
 * rethrows, so a test names the one element it means.
 */
export function isPreDispatchClickError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const message = error.message;
	if (!/^locator\.click: Timeout \d+ms exceeded\./.test(message)) return false;
	if (!message.includes("Call log:")) return false;
	return !/performing click action|click action done|waiting for scheduled navigations/.test(
		message,
	);
}

export interface ClickByRoleOptions {
	timeout?: number;
	/** Match the accessible name exactly instead of as a substring. */
	exact?: boolean;
	/** Look inside this element only, for names that repeat elsewhere. */
	within?: Locator;
}

/**
 * Finds the elements of `role` in `root` whose label matches `name`. Clicks
 * the match only when there is exactly one, and returns how many matched, so
 * an ambiguous name never clicks the first of several. Matching ignores whitespace so a label built from adjacent
 * elements ("Account" + "account.get") matches the accessible name Playwright
 * computes ("Account account.get"). Runs in the page.
 */
function domClickByRole(
	root: ParentNode,
	args: { role: string; name: string; exact: boolean },
): number {
	const squash = (text: string) => text.replace(/\s+/g, "");
	// Own aria-label wins. Otherwise the content, where a descendant that has an
	// aria-label contributes that label instead of its text (the way a browser
	// names "Unread Thread" + status "Unread" + "Echo Bot").
	const nameFromContent = (node: Element): string => {
		const own = node.getAttribute("aria-label");
		if (own !== null) return own;
		let out = "";
		for (const child of node.childNodes) {
			if (child.nodeType === 3) out += child.textContent ?? "";
			else if (child.nodeType === 1)
				out += ` ${nameFromContent(child as Element)} `;
		}
		return out.trim();
	};
	const wanted = squash(args.name);
	const matches: HTMLElement[] = [];
	for (const node of root.querySelectorAll("[role], button, a, textarea")) {
		const implicit =
			node.getAttribute("role") ??
			(node.tagName === "BUTTON"
				? "button"
				: node.tagName === "A"
					? "link"
					: node.tagName === "TEXTAREA"
						? "textbox"
						: "");
		if (implicit !== args.role) continue;
		const label = squash(nameFromContent(node));
		if (args.exact ? label === wanted : label.includes(wanted)) {
			matches.push(node as HTMLElement);
		}
	}
	if (matches.length === 1) matches[0]?.click();
	return matches.length;
}

function clickErrorText(error: unknown): string {
	return error instanceof Error ? error.message : "";
}

function clickDispatched(error: unknown): boolean {
	return clickErrorText(error).includes("click action done");
}

function clickCovered(error: unknown): boolean {
	return clickErrorText(error).includes("intercepts pointer events");
}

/**
 * The pointer action started and nothing else received it. A second click
 * would act twice. A parent that intercepts the pointer is not this case,
 * even when the log also says "performing click action".
 */
function clickStarted(error: unknown): boolean {
	const message = clickErrorText(error);
	return (
		(clickDispatched(error) || message.includes("performing click action")) &&
		!clickCovered(error)
	);
}

function isLocatorWaitTimeout(error: unknown): boolean {
	return (
		error instanceof Error &&
		/^locator\.waitFor: Timeout \d+ms exceeded\./.test(error.message)
	);
}

function isFillTimeout(error: unknown): boolean {
	return (
		error instanceof Error &&
		/^locator\.fill: Timeout \d+ms exceeded\./.test(error.message)
	);
}

function escapeAttrValue(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/**
 * True when `node` is the element under its own center. Playwright's hit
 * test uses the same `elementFromPoint` check; Obscura often names a parent
 * pane or the owning dialog as that element (obscura#45) and then retries
 * the pointer action until the deadline.
 */
function elementIsHitTarget(node: Element): boolean {
	node.scrollIntoView({ block: "nearest", inline: "nearest" });
	const rect = node.getBoundingClientRect();
	const left = Math.max(rect.left, 0);
	const top = Math.max(rect.top, 0);
	const right = Math.min(rect.right, window.innerWidth);
	const bottom = Math.min(rect.bottom, window.innerHeight);
	if (right - left < 1 || bottom - top < 1) return false;
	const hit = document.elementFromPoint(
		left + (right - left) / 2,
		top + (bottom - top) / 2,
	);
	return hit !== null && (hit === node || node.contains(hit));
}

/** Real locators can measure a box. The contract fakes cannot. */
function canHitTest(locator: Locator): boolean {
	return (
		typeof (locator as { boundingBox?: unknown }).boundingBox === "function"
	);
}

/**
 * One pointer click when this element is the hit target, so the action is
 * allowed to finish. Waits for the primary role locator or the hidden-role
 * fallback together, never sits 15s on a disabled control, and falls back to
 * one DOM click when the element is covered or Obscura stalls on click.
 */
async function clickAtHitTarget(
	locator: Locator,
	fallbackLocator: Locator,
	role: string,
	name: string,
	budget: number,
): Promise<"done" | "fallback"> {
	try {
		await locator.or(fallbackLocator).first().waitFor({
			state: "visible",
			timeout: budget,
		});
	} catch (error) {
		if (!isLocatorWaitTimeout(error)) throw error;
		return "fallback";
	}
	const probe = await locator.evaluateAll((nodes) => {
		if (nodes.length === 0) return "fallback" as const;
		if (nodes.length > 1) return "click" as const;
		const node = nodes[0];
		if (!node) return "fallback" as const;
		if (
			node.matches(":disabled") ||
			node.getAttribute("aria-disabled") === "true"
		) {
			return "disabled" as const;
		}
		node.scrollIntoView({ block: "nearest", inline: "nearest" });
		const rect = node.getBoundingClientRect();
		const left = Math.max(rect.left, 0);
		const top = Math.max(rect.top, 0);
		const right = Math.min(rect.right, window.innerWidth);
		const bottom = Math.min(rect.bottom, window.innerHeight);
		if (right - left < 1 || bottom - top < 1) return "fallback" as const;
		const hit = document.elementFromPoint(
			left + (right - left) / 2,
			top + (bottom - top) / 2,
		);
		return hit !== null && (hit === node || node.contains(hit))
			? ("click" as const)
			: ("fallback" as const);
	});
	if (probe === "fallback") return "fallback";
	if (probe === "disabled") {
		try {
			await expect(locator).toBeEnabled({ timeout: Math.min(2_000, budget) });
		} catch {
			throw new Error(`clickByRole: ${role} "${name}" is disabled`);
		}
		const hit = await locator.evaluate(elementIsHitTarget);
		if (!hit) return "fallback";
	}
	const clickBudget = Math.min(6_000, budget);
	try {
		await locator.click({ timeout: clickBudget });
		return "done";
	} catch (error) {
		if (clickStarted(error)) return "done";
		if (!clickCovered(error) && !isPreDispatchClickError(error)) throw error;
		return "fallback";
	}
}

/**
 * Classify a click that cannot be hit-tested. One probe, then at most one
 * more click when the control was missing and can be waited for. A click
 * that already started is not repeated.
 */
async function clickByClassification(
	locator: Locator,
	budget: number,
): Promise<"done" | "fallback"> {
	const probe = Math.min(2_000, budget);
	try {
		await locator.click({ timeout: probe });
		return "done";
	} catch (error) {
		if (clickStarted(error)) return "done";
		if (!clickCovered(error) && !isPreDispatchClickError(error)) throw error;
		if (
			!clickCovered(error) &&
			budget > probe &&
			typeof locator.waitFor === "function"
		) {
			let visible = false;
			try {
				await locator.waitFor({
					state: "visible",
					timeout: budget - probe,
				});
				visible = true;
			} catch (waitError) {
				if (!isLocatorWaitTimeout(waitError)) throw waitError;
			}
			if (visible) {
				try {
					await locator.click({ timeout: budget - probe });
					return "done";
				} catch (again) {
					if (clickStarted(again)) return "done";
					if (!clickCovered(again) && !isPreDispatchClickError(again)) {
						throw again;
					}
				}
			}
		}
	}
	return "fallback";
}

export async function clickByRole(
	page: Page,
	role: Parameters<Page["getByRole"]>[0],
	name: string,
	options: ClickByRoleOptions = {},
): Promise<void> {
	const exact = options.exact ?? false;
	const scope = options.within ?? page;
	const locator = scope.getByRole(role, { name, exact });
	// One real click and no trial click: hosted CI traces showed requests
	// inside a trial click's window (not reproduced locally, cause unproven).
	// Only an error that proves the real click never dispatched may fall back
	// to the DOM click.
	const budget = options.timeout ?? 10_000;
	const outcome = canHitTest(locator)
		? await clickAtHitTarget(
				locator,
				scope.getByRole(role, { name, exact, includeHidden: true }),
				role,
				name,
				budget,
			)
		: await clickByClassification(locator, budget);
	if (outcome === "done") return;
	const args = { role, name, exact };
	const root = options.within ?? page.locator(":root");
	const matched = await root.evaluate(domClickByRole, args);
	// A fallback that finds nothing, or cannot pick one element, must fail the
	// test instead of passing silently or clicking the wrong element.
	if (matched === 0) {
		throw new Error(`clickByRole: no ${role} named "${name}" to click`);
	}
	if (matched > 1) {
		throw new Error(
			`clickByRole: ${matched} ${role}s match "${name}"; nothing was clicked`,
		);
	}
}

/** Horizontal swipe via DOM pointer events. Avoids CDP Input.setInterceptDrags. */
export async function swipeLeft(page: Page, name: string): Promise<void> {
	const locator = page.getByRole("button", { name, exact: true });
	await locator.evaluate((node) => {
		let target = node instanceof HTMLElement ? node : null;
		while (target && !target.style.transform) {
			target = target.parentElement;
		}
		if (!target) return;
		const rect = target.getBoundingClientRect();
		const y = rect.top + rect.height / 2;
		const startX = rect.right - 24;
		const fire = (type: string, x: number) => {
			const event = new PointerEvent(type, {
				bubbles: true,
				cancelable: true,
				pointerId: 1,
				pointerType: "touch",
				isPrimary: true,
				clientX: x,
				clientY: y,
				buttons: type === "pointerup" ? 0 : 1,
			});
			if (event.clientX !== x) {
				Object.defineProperty(event, "clientX", { value: x });
				Object.defineProperty(event, "clientY", { value: y });
			}
			target?.dispatchEvent(event);
		};
		fire("pointerdown", startX);
		fire("pointermove", startX - 40);
		fire("pointermove", startX - 90);
		fire("pointerup", startX - 90);
	});
}

export async function fillByLabel(
	page: Page,
	name: string,
	value: string,
	options: { timeout?: number } = {},
) {
	const budget = options.timeout ?? 10_000;
	const attr = escapeAttrValue(name);
	const primary = page.getByRole("textbox", { name });
	const fallback = page.locator(
		`textarea[aria-label="${attr}"], input[aria-label="${attr}"], textarea[placeholder="${attr}"], input[placeholder="${attr}"]`,
	);
	const target = primary.or(fallback);
	try {
		await target.waitFor({ state: "visible", timeout: budget });
	} catch (error) {
		if (isLocatorWaitTimeout(error)) {
			throw new Error(
				`fillByLabel: no visible textbox matching "${name}" within ${budget}ms`,
			);
		}
		throw error;
	}
	if (await target.isDisabled()) {
		try {
			await expect(target).toBeEnabled({ timeout: Math.min(2_000, budget) });
		} catch {
			throw new Error(`fillByLabel: textbox "${name}" is disabled`);
		}
	}
	try {
		await target.fill(value, { timeout: Math.min(5_000, budget) });
	} catch (error) {
		if (!isFillTimeout(error)) throw error;
		const filled = await target.evaluate((node, next) => {
			if (
				!(
					node instanceof HTMLInputElement ||
					node instanceof HTMLTextAreaElement
				)
			) {
				return false;
			}
			if (node.disabled) return false;
			const proto = (
				node instanceof HTMLTextAreaElement
					? HTMLTextAreaElement
					: HTMLInputElement
			).prototype;
			const set = Object.getOwnPropertyDescriptor(proto, "value")?.set;
			if (set) set.call(node, next);
			else node.value = next;
			node.dispatchEvent(new Event("input", { bubbles: true }));
			node.dispatchEvent(new Event("change", { bubbles: true }));
			return true;
		}, value);
		if (!filled) {
			throw new Error(`fillByLabel: could not fill textbox "${name}"`);
		}
	}
}

export async function chooseOption(
	page: Page,
	name: string,
	option: string,
): Promise<void> {
	const group = page.getByRole("radiogroup", { name });
	const locator = group.getByRole("radio", { name: option });
	await group.waitFor({ state: "visible", timeout: 10_000 });
	try {
		await locator.click({ timeout: 2_000 });
	} catch (error) {
		if (!isPreDispatchClickError(error)) throw error;
		const clicked = await page.evaluate(
			({ groupName, optionName }) => {
				const groups = document.querySelectorAll(
					'[role="radiogroup"], fieldset',
				);
				for (const grp of groups) {
					const grpLabel = grp.getAttribute("aria-label") ?? "";
					if (!grpLabel.includes(groupName)) continue;
					const radios = grp.querySelectorAll('[role="radio"], button');
					for (const radio of radios) {
						const label =
							radio.getAttribute("aria-label") ??
							radio.textContent?.trim() ??
							"";
						if (label === optionName || label.includes(optionName)) {
							(radio as HTMLElement).click();
							return true;
						}
					}
				}
				return false;
			},
			{ groupName: name, optionName: option },
		);
		if (!clicked) {
			throw new Error(
				`chooseOption: no option "${option}" in radiogroup "${name}"`,
			);
		}
	}
}
