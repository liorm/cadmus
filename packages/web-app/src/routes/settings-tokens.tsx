import type { AuthTokensListResult } from "@cadmus/contract/types";

type TokenSummary = AuthTokensListResult["tokens"][number];

import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { ElevationHelp } from "@/components/ElevationHelp";
import { fieldClass } from "@/components/SettingsRows";
import { LoadGate } from "@/components/Skeleton";
import { useCadmus } from "@/context/CadmusContext";
import { useSession } from "@/context/SessionContext";
import { useScopedResource } from "@/hooks/useScopedResource";
import { isoTime } from "@/lib/session";

const buttonClass =
	"min-h-tap rounded-md border border-border px-3 disabled:opacity-50";
const PRESETS: Record<string, string[]> = {
	"Chat and read bots": ["chat.use", "bot.read"],
	"Build bots and knowledge": [
		"chat.use",
		"bot.read",
		"bot.write",
		"knowledge.write",
	],
};

export function TokensSettingsPage() {
	const { client } = useCadmus();
	const session = useSession();
	// Service tokens belong to the account, so only account admins manage them.
	// Personal tokens stay open to a signed-in user session. Signed out cannot
	// mint or manage tokens.
	const principal = session.principal;
	const principalPending = session.signedIn && principal === null;
	// A token session cannot mint tokens at all (the server rejects it), so
	// the create form is hidden for it. It can still revoke its own tokens.
	const canMint = session.signedIn && Boolean(principal && !principal.viaToken);
	const canManageService =
		session.signedIn &&
		Boolean(
			principal && !principal.viaToken && principal.role === "account-admin",
		);
	const [notice, setNotice] = useState<string | null>(null);
	const [label, setLabel] = useState("");
	const [kindChoice, setKindChoice] = useState<"pat" | "service">("service");
	const kind = canManageService ? kindChoice : "pat";
	const [preset, setPreset] = useState(Object.keys(PRESETS)[0] ?? "");
	const [ttlDays, setTtlDays] = useState("7");
	const [secret, setSecret] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	// Service tokens and revoking other members' tokens are admin-mode uses.
	const [needsAdmin, setNeedsAdmin] = useState(false);

	const loaded = useScopedResource("tokens", async () => {
		const res = await client.callRpc<{ tokens?: TokenSummary[] }>(
			"auth.tokens.list",
		);
		if (!res.ok) {
			throw new Error(res.error?.message ?? "Could not load tokens");
		}
		return res.result?.tokens ?? [];
	});
	const tokens = loaded.data ?? [];

	const run = async (
		fn: () => Promise<{
			ok: boolean;
			error?: { message?: string; code?: string };
			result?: unknown;
		}>,
	) => {
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const res = await fn();
			if (!res.ok) {
				if (res.error?.code === "elevation_required") setNeedsAdmin(true);
				setError(res.error?.message ?? "That did not work");
				return;
			}
			const revoked = (res.result as { revoked?: boolean } | undefined)
				?.revoked;
			if (revoked === false) {
				setNotice(
					"No change was made. The token may already be revoked, or it was not found or not yours to revoke.",
				);
			}
			loaded.retry();
		} catch (err: unknown) {
			setError(err instanceof Error ? err.message : "Network error");
		} finally {
			setBusy(false);
		}
	};

	return (
		<AppShell title="API tokens" backTo="/settings">
			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-4">
				<p className="text-[length:var(--fs-sm)] text-text-muted">
					Tokens let agents and scripts sign in with only the access you pick.
					Exchange one at POST /api/auth/login/token. The secret is shown once.
				</p>
				{error ? (
					<p role="alert" className="text-destructive">
						{error}
					</p>
				) : null}
				{notice ? (
					<p role="status" aria-label="Token change">
						{notice}
					</p>
				) : null}
				{principalPending || (canMint && canManageService) ? null : (
					<p className="text-[length:var(--fs-sm)] text-text-muted">
						{canMint
							? "Only account admins manage service tokens. You can create personal tokens."
							: "Token sessions cannot create tokens. Sign in as a user to create one."}
					</p>
				)}
				{canManageService ? (
					<ElevationHelp
						needed={needsAdmin}
						onEnabled={() => {
							setNeedsAdmin(false);
							setError(null);
						}}
					/>
				) : null}
				{secret ? (
					<div
						role="status"
						className="flex flex-col gap-2 rounded-md border border-border bg-surface p-3"
					>
						<span className="font-semibold">Copy this token now</span>
						<fieldset
							aria-label="New token secret"
							className="m-0 border-0 p-0"
						>
							<code className="break-all">{secret}</code>
						</fieldset>
						<button
							type="button"
							className={buttonClass}
							onClick={() => setSecret(null)}
						>
							I copied it
						</button>
					</div>
				) : null}
				{canMint ? (
					<form
						className="flex flex-col gap-2"
						onSubmit={(event) => {
							event.preventDefault();
							const days = Number(ttlDays);
							const expiryOk = Number.isFinite(days) && days > 0;
							// A personal token with no expiry is rejected. Service tokens
							// still default to 7 days when the field is empty.
							if (!canMint || !label.trim()) return;
							if (kind === "pat" && !expiryOk) return;
							void run(async () => {
								const res = await client.callRpc<{ token?: string }>(
									"auth.tokens.create",
									{
										kind,
										label: label.trim(),
										grants: PRESETS[preset] ?? [],
										...(expiryOk ? { ttlDays: days } : {}),
									},
								);
								if (res.ok && res.result?.token) {
									setSecret(res.result.token);
									setLabel("");
								}
								return res;
							});
						}}
					>
						<label className="flex flex-col gap-1">
							<span>Label</span>
							<input
								aria-label="Token label"
								className={fieldClass}
								value={label}
								disabled={busy}
								onChange={(event) => setLabel(event.target.value)}
							/>
						</label>
						<label className="flex flex-col gap-1">
							<span>Kind</span>
							<select
								aria-label="Token kind"
								className={fieldClass}
								value={kind}
								disabled={busy}
								onChange={(event) =>
									setKindChoice(
										event.target.value === "pat" ? "pat" : "service",
									)
								}
							>
								{canManageService ? (
									<option value="service">
										Service token (account admins)
									</option>
								) : null}
								<option value="pat">Personal token</option>
							</select>
						</label>
						<label className="flex flex-col gap-1">
							<span>Access</span>
							<select
								aria-label="Token access"
								className={fieldClass}
								value={preset}
								disabled={busy}
								onChange={(event) => setPreset(event.target.value)}
							>
								{Object.keys(PRESETS).map((name) => (
									<option key={name} value={name}>
										{name}
									</option>
								))}
							</select>
						</label>
						<label className="flex flex-col gap-1">
							<span>Expires in days</span>
							<input
								aria-label="Token expiry days"
								className={fieldClass}
								inputMode="numeric"
								value={ttlDays}
								disabled={busy}
								onChange={(event) => setTtlDays(event.target.value)}
							/>
						</label>
						<button
							type="submit"
							className={buttonClass}
							disabled={
								busy ||
								!label.trim() ||
								(kind === "pat" && !(Number(ttlDays) > 0))
							}
						>
							Create token
						</button>
					</form>
				) : null}
				<LoadGate
					phase={loaded.phase}
					error={loaded.error}
					onRetry={loaded.retry}
					label="Loading tokens"
				>
					<ul className="overflow-hidden rounded-md border border-border bg-surface">
						{tokens.length === 0 ? (
							<li className="px-3 py-3 text-text-muted">No tokens yet.</li>
						) : null}
						{tokens.map((token) => (
							<li
								key={token.id}
								className="flex items-center gap-3 border-b border-border px-3 py-3 last:border-b-0"
							>
								<span className="min-w-0 flex-1">
									<span className="block font-semibold">{token.label}</span>
									<span className="block break-words text-[length:var(--fs-sm)] text-text-muted">
										{token.kind}
										{token.revokedAt
											? " · revoked"
											: token.expiresAt
												? ` · expires ${isoTime(token.expiresAt)}`
												: " · no expiry"}
									</span>
								</span>
								{token.revokedAt ||
								(token.kind === "service" && !canManageService) ? null : (
									<button
										type="button"
										className={buttonClass}
										disabled={busy}
										aria-label={`Revoke token ${token.label}`}
										onClick={() => {
											void run(() =>
												client.callRpc("auth.tokens.revoke", {
													tokenId: token.id,
												}),
											);
										}}
									>
										Revoke
									</button>
								)}
							</li>
						))}
					</ul>
				</LoadGate>
			</div>
		</AppShell>
	);
}
