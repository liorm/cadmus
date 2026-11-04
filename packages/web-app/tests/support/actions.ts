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
