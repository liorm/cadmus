import { describe, expect, it } from "bun:test";
import {
	defaultRouteForRole,
	isRouteAllowedForRole,
	normalizePersonaRole,
} from "./persona-routing";

describe("persona-routing", () => {
	it("normalizes roles safely and maps default routes", () => {
		expect(normalizePersonaRole("super-admin")).toBe("super-admin");
		expect(normalizePersonaRole("account-admin")).toBe("account-admin");
		expect(normalizePersonaRole("user")).toBe("user");
		expect(normalizePersonaRole(undefined)).toBe("user");
		expect(defaultRouteForRole("super-admin")).toBe("/system");
		expect(defaultRouteForRole("account-admin")).toBe("/admin");
		expect(defaultRouteForRole("user")).toBe("/bots");
	});

	it("enforces strict persona route isolation", () => {
		expect(isRouteAllowedForRole("/bots", "user")).toBe(true);
		expect(isRouteAllowedForRole("/app/bot/scribe", "user")).toBe(true);
		expect(isRouteAllowedForRole("/schedules", "user")).toBe(true);
		expect(isRouteAllowedForRole("/envs", "user")).toBe(true);
		expect(isRouteAllowedForRole("/skills", "user")).toBe(true);
		expect(isRouteAllowedForRole("/search", "user")).toBe(true);
		expect(isRouteAllowedForRole("/admin", "user")).toBe(false);
		expect(isRouteAllowedForRole("/system", "user")).toBe(false);

		expect(isRouteAllowedForRole("/admin", "account-admin")).toBe(true);
		expect(isRouteAllowedForRole("/admin/members", "account-admin")).toBe(true);
		expect(isRouteAllowedForRole("/admin/providers", "account-admin")).toBe(
			true,
		);
		expect(isRouteAllowedForRole("/bots", "account-admin")).toBe(false);
		expect(isRouteAllowedForRole("/system", "account-admin")).toBe(false);

		expect(isRouteAllowedForRole("/system", "super-admin")).toBe(true);
		expect(
			isRouteAllowedForRole("/system/tenants/acc_123", "super-admin"),
		).toBe(true);
		expect(isRouteAllowedForRole("/admin", "super-admin")).toBe(false);
		expect(isRouteAllowedForRole("/bots", "super-admin")).toBe(false);
	});
});
