/**
 * Role/label helpers. Playwright locators first; evaluate fallbacks for
 * engines where locator click/fill time out (obscura#45).
 */
import type { Page } from "@playwright/test";

export async function clickByRole(
	page: Page,
	role: Parameters<Page["getByRole"]>[0],
	name: string,
): Promise<void> {
	const locator = page.getByRole(role, { name });
	try {
		await locator.click({ timeout: 2_000 });
	} catch {
		await page.evaluate(
			({ roleName, accessibleName }) => {
				const nodes = document.querySelectorAll("*");
				for (const node of nodes) {
					const implicit =
						node.getAttribute("role") ??
						(node.tagName === "BUTTON"
							? "button"
							: node.tagName === "A"
								? "link"
								: node.tagName === "TEXTAREA"
									? "textbox"
									: "");
					if (implicit !== roleName) continue;
					const label =
						node.getAttribute("aria-label") ?? node.textContent?.trim() ?? "";
					if (label === accessibleName || label.includes(accessibleName)) {
						(node as HTMLElement).click();
						return;
					}
				}
			},
			{ roleName: role, accessibleName: name },
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

export async function fillByLabel(page: Page, name: string, value: string) {
	const locator = page.getByRole("textbox", { name });
	try {
		await locator.fill(value, { timeout: 2_000 });
	} catch {
		await page.evaluate(
			({ accessibleName, next }) => {
				const nodes = document.querySelectorAll("textarea, input");
				for (const node of nodes) {
					const label =
						node.getAttribute("aria-label") ??
						node.getAttribute("placeholder") ??
						"";
					if (label === accessibleName) {
						const el = node as HTMLTextAreaElement;
						el.value = next;
						el.dispatchEvent(new Event("input", { bubbles: true }));
						el.dispatchEvent(new Event("change", { bubbles: true }));
						return;
					}
				}
			},
			{ accessibleName: name, next: value },
		);
	}
}

export async function chooseOption(
	page: Page,
	name: string,
	option: string,
): Promise<void> {
	const group = page.getByRole("radiogroup", { name });
	const locator = group.getByRole("radio", { name: option });
	try {
		await locator.click({ timeout: 2_000 });
	} catch {
		await page.evaluate(
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
							return;
						}
					}
				}
			},
			{ groupName: name, optionName: option },
		);
	}
}
