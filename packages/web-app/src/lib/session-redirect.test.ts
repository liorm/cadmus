import { describe, expect, it } from "bun:test";
import { buildLoginRedirectUrl } from "./session";

describe("buildLoginRedirectUrl", () => {
	it("returns bare /login from /app root and encodes deep /app links as next", () => {
		expect(buildLoginRedirectUrl("/app", "")).toBe("/login");
		expect(buildLoginRedirectUrl("/app/", "")).toBe("/login");
		expect(buildLoginRedirectUrl("/app/chat/abc", "?view=raw")).toBe(
			"/login?next=%2Fapp%2Fchat%2Fabc%3Fview%3Draw",
		);
		expect(buildLoginRedirectUrl("/app", "?tab=1")).toBe(
			"/login?next=%2Fapp%3Ftab%3D1",
		);
		expect(buildLoginRedirectUrl("/other", "")).toBe("/login");
	});
});
