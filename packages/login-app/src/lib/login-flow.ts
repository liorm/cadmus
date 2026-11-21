import type { SessionMembership } from "./session";

const ROLE_RANK = ["user", "account-admin", "super-admin"];
const SENTINEL_ORIGIN = "https://cadmus.invalid";

export interface HatChoice {
	role: string;
	accountId: string;
	accountName: string;
	label: string;
}

export type LoginStage =
	| "loading"
	| "retrying"
	| "unavailable"
	| "sign-in"
	| "choose-role"
	| "device-approve"
	| "redirect-app";

function hasUnsafePathChars(raw: string): boolean {
	for (let i = 0; i < raw.length; i++) {
		const code = raw.charCodeAt(i);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return raw.includes("\\");
}

/**
 * Validates a `?next=` redirect target so post-login navigation stays inside `/app`.
 */
export function sanitizeNextPath(raw: string | null | undefined): string {
	if (!raw) return "/app";
	const trimmed = raw.trim();
	if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return "/app";
	if (hasUnsafePathChars(trimmed)) return "/app";
	try {
		const parsed = new URL(trimmed, SENTINEL_ORIGIN);
		if (parsed.origin !== SENTINEL_ORIGIN) return "/app";
		if (parsed.pathname !== "/app" && !parsed.pathname.startsWith("/app/")) {
			return "/app";
		}
		return `${parsed.pathname}${parsed.search}${parsed.hash}`;
	} catch {
		return "/app";
	}
}

const AUTH_ERROR_MESSAGES: Record<string, string> = {
	not_invited: "This email has not been invited to Cadmus.",
	login_denied: "Sign-in was canceled.",
	locked_out: "Too many failed sign-in attempts. Try again later.",
	rate_limited: "Too many sign-in requests. Wait a moment and try again.",
	bad_state: "Your sign-in session expired. Please try again.",
	bad_nonce: "Sign-in verification failed. Please try again.",
	bad_audience: "Sign-in verification failed. Please try again.",
	bad_id_token: "Sign-in could not be verified. Please try again.",
	token_expired: "Sign-in response expired. Please try again.",
	email_not_verified: "Your email address must be verified before signing in.",
	login_method_revoked: "This sign-in method has been revoked.",
	method_in_use: "This sign-in method is already linked to another user.",
	user_disabled: "This user account has been disabled.",
	account_suspended: "This account is currently suspended.",
};

export function authErrorMessage(
	code: string | null | undefined,
): string | null {
	const normalized = code?.trim();
	if (!normalized) return null;
	return AUTH_ERROR_MESSAGES[normalized] ?? "Sign-in failed. Please try again.";
}

export function hatChoices(memberships: SessionMembership[]): HatChoice[] {
	const choices: HatChoice[] = [];
	for (const membership of memberships) {
		for (const role of membership.roles) {
			choices.push({
				role,
				accountId: membership.accountId,
				accountName: membership.name,
				label: `${role} in ${membership.name}`,
			});
		}
	}
	return choices.sort((a, b) => {
		const ra = ROLE_RANK.indexOf(a.role);
		const rb = ROLE_RANK.indexOf(b.role);
		const rankDiff = (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
		return rankDiff !== 0 ? rankDiff : a.label.localeCompare(b.label);
	});
}

/**
 * Builds the `/api/auth/login/google/start` navigation URL, forwarding
 * `chooseRole=1` when checked and a validated `returnTo` (`/login/device` for
 * device approval, or the deep `/app/...` path when present).
 */
export function buildGoogleStartUrl(options: {
	chooseRole: boolean;
	deviceCode: string | null;
	next: string;
}): string {
	const params = new URLSearchParams();
	if (options.chooseRole) params.set("chooseRole", "1");
	if (options.deviceCode) {
		params.set("returnTo", "/login/device");
	} else {
		const safeNext = sanitizeNextPath(options.next);
		if (safeNext !== "/app" && safeNext !== "/app/") {
			params.set("returnTo", safeNext);
		}
	}
	const qs = params.toString();
	return qs
		? `/api/auth/login/google/start?${qs}`
		: "/api/auth/login/google/start";
}

export function resolveLoginStage(input: {
	bootPhase: "loading" | "retrying" | "unavailable" | "ready";
	signedIn: boolean;
	provisional: boolean;
	deviceCode: string | null;
}): LoginStage {
	if (input.bootPhase === "loading") return "loading";
	if (input.bootPhase === "retrying") return "retrying";
	if (input.bootPhase === "unavailable") return "unavailable";
	if (!input.signedIn) return "sign-in";
	if (input.provisional) return "choose-role";
	if (input.deviceCode) return "device-approve";
	return "redirect-app";
}
