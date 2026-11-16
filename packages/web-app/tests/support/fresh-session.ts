/**
 * Test-only setup for real-ceremony passkey specs. A session with a real
 * Google login method and a chosen `freshGoogleAt` cannot come from the app's
 * own routes (only the real Google callback writes that column), so the specs
 * ask the worker they test, through a fixed set of typed operations served by
 * `packages/worker/tests/harness/real-session-worker.ts`. Everything after
 * this point (refresh, enroll, elevate, remove) is the real backend.
 *
 * It fails closed: with no harness token, or a server that does not answer the
 * harness, `openFixture` throws. There is no second way to open the database.
 */
import { uniqueAccountId } from "./account.ts";

// Same host as the Playwright baseURL; the harness accepts it as local.
const BASE = "http://127.0.0.1:8799";
const PREFIX = "/api/__test-harness/";

export interface FreshSession {
	accountId: string;
	userId: string;
	sessionId: string;
	refreshToken: string;
	accessToken: string;
	googleMethodId: string;
}

export type AuditAction =
	| "auth.passkey.register"
	| "auth.passkey.remove"
	| "auth.elevate"
	| "auth.elevation.end";

export async function openFixture() {
	const token = process.env.CADMUS_HARNESS_TOKEN;
	if (!token) {
		throw new Error(
			"real-session harness is not enabled (CADMUS_REAL_SESSION_HARNESS=1 starts the server with it)",
		);
	}
	const call = async <T>(op: string, body: object): Promise<T> => {
		const res = await fetch(`${BASE}${PREFIX}${op}`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-harness-token": token },
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			throw new Error(`harness ${op} answered HTTP ${res.status}`);
		}
		return (await res.json()) as T;
	};
	const reply = await call<{ harness?: boolean }>("ping", {}).catch(() => null);
	if (reply?.harness !== true) {
		throw new Error(
			"the server on :8799 does not answer the real-session harness",
		);
	}
	const n = async (op: string, body: object) =>
		(await call<{ n: number }>(op, body)).n;
	return {
		/** An account-admin user session whose Google sign-in was `freshAgeMs` ago. */
		session: (freshAgeMs = 0) =>
			call<FreshSession>("session", {
				accountId: uniqueAccountId("pk"),
				freshAgeMs,
			}),
		/** A passkey login method and passkey row owned by `userId`. */
		async seedPasskey(userId: string): Promise<string> {
			return (await call<{ methodId: string }>("seedPasskey", { userId }))
				.methodId;
		},
		activePasskeys: (userId: string) => n("activePasskeys", { userId }),
		passkeyRows: (userId: string) => n("passkeyRows", { userId }),
		activePasskeyMethods: (userId: string) =>
			n("activePasskeyMethods", { userId }),
		async activePasskeyMethodId(userId: string): Promise<string | null> {
			return (
				await call<{ id: string | null }>("activePasskeyMethodId", { userId })
			).id;
		},
		auditCount: (userId: string, action: AuditAction) =>
			n("auditCount", { userId, action }),
		async elevatedUntil(sessionId: string): Promise<number | null> {
			return (await call<{ e: number | null }>("elevatedUntil", { sessionId }))
				.e;
		},
		async registerChallenge(userId: string) {
			return (
				await call<{
					row: {
						rp_id: string;
						origin: string;
						consumed_at: number | null;
					} | null;
				}>("registerChallenge", { userId })
			).row;
		},
		async close() {},
	};
}
