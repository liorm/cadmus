import { describe, expect, it } from "bun:test";
import {
	authErrorMessage,
	buildGoogleStartUrl,
	hatChoices,
	resolveLoginStage,
	sanitizeNextPath,
} from "../../src/lib/login-flow";

describe("sanitizeNextPath", () => {
	it("accepts /app paths with search and hash", () => {
		expect(sanitizeNextPath("/app")).toBe("/app");
		expect(sanitizeNextPath("/app/chat/abc?view=raw#bottom")).toBe(
			"/app/chat/abc?view=raw#bottom",
		);
	});

	it("rejects open-redirect and non-/app targets", () => {
		for (const bad of [
			null,
			undefined,
			"",
			"/",
			"/login",
			"/app-evil",
			"//evil.example/app",
			"https://evil.example/app",
			"javascript:alert(1)",
			"/app\\evil",
		]) {
			expect(sanitizeNextPath(bad), String(bad)).toBe("/app");
		}
	});
});

describe("authErrorMessage", () => {
	it("maps known auth_error codes and falls back cleanly", () => {
		expect(authErrorMessage(null)).toBeNull();
		expect(authErrorMessage("")).toBeNull();
		expect(authErrorMessage("not_invited")).toContain("invited");
		expect(authErrorMessage("rate_limited")).toContain("Too many");
		expect(authErrorMessage("unknown_code")).toContain("Sign-in failed");
	});
});

describe("hatChoices", () => {
	it("sorts by role rank (user -> account-admin -> super-admin) then label", () => {
		const choices = hatChoices([
			{ accountId: "sys", name: "System", roles: ["super-admin"] },
			{ accountId: "b", name: "Beta", roles: ["account-admin", "user"] },
			{ accountId: "a", name: "Alpha", roles: ["user"] },
		]);
		expect(choices.map((c) => `${c.role}@${c.accountName}`)).toEqual([
			"user@Alpha",
			"user@Beta",
			"account-admin@Beta",
			"super-admin@System",
		]);
	});
});

describe("buildGoogleStartUrl", () => {
	it("omits query params for plain default login", () => {
		expect(
			buildGoogleStartUrl({
				chooseRole: false,
				deviceCode: null,
				next: "/app",
			}),
		).toBe("/api/auth/login/google/start");
	});

	it("includes chooseRole=1 and deep /app returnTo when requested", () => {
		expect(
			buildGoogleStartUrl({
				chooseRole: true,
				deviceCode: null,
				next: "/app/settings/security",
			}),
		).toBe(
			"/api/auth/login/google/start?chooseRole=1&returnTo=%2Fapp%2Fsettings%2Fsecurity",
		);
	});

	it("forces returnTo=/login/device when approving a device", () => {
		expect(
			buildGoogleStartUrl({
				chooseRole: true,
				deviceCode: "ABCD-EFGH",
				next: "/app/chat/1",
			}),
		).toBe(
			"/api/auth/login/google/start?chooseRole=1&returnTo=%2Flogin%2Fdevice",
		);
	});
});

describe("resolveLoginStage", () => {
	it("resolves boot, sign-in, 2-stage role picker, device approval, and app redirect", () => {
		expect(
			resolveLoginStage({
				bootPhase: "loading",
				signedIn: false,
				provisional: false,
				deviceCode: null,
			}),
		).toBe("loading");
		expect(
			resolveLoginStage({
				bootPhase: "retrying",
				signedIn: false,
				provisional: false,
				deviceCode: null,
			}),
		).toBe("retrying");
		expect(
			resolveLoginStage({
				bootPhase: "unavailable",
				signedIn: false,
				provisional: false,
				deviceCode: null,
			}),
		).toBe("unavailable");
		expect(
			resolveLoginStage({
				bootPhase: "ready",
				signedIn: false,
				provisional: false,
				deviceCode: null,
			}),
		).toBe("sign-in");
		expect(
			resolveLoginStage({
				bootPhase: "ready",
				signedIn: true,
				provisional: true,
				deviceCode: null,
			}),
		).toBe("choose-role");
		expect(
			resolveLoginStage({
				bootPhase: "ready",
				signedIn: true,
				provisional: true,
				deviceCode: "ABCD-EFGH",
			}),
		).toBe("choose-role");
		expect(
			resolveLoginStage({
				bootPhase: "ready",
				signedIn: true,
				provisional: false,
				deviceCode: "ABCD-EFGH",
			}),
		).toBe("device-approve");
		expect(
			resolveLoginStage({
				bootPhase: "ready",
				signedIn: true,
				provisional: false,
				deviceCode: null,
			}),
		).toBe("redirect-app");
	});
});
