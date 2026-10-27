import type {
	ToolsEnvRecord,
	ToolsEnvSecretMetaRecord,
} from "@cadmus/contract/types";
import { useCallback, useEffect, useState } from "react";
import { useCadmus } from "../context/CadmusContext.js";

interface ToolsEnvSettingsProps {
	isOpen: boolean;
	onClose: () => void;
}

function formatTimestamp(ms: number): string {
	return new Date(ms).toISOString();
}

function daemonEnvsUsingSecret(
	envs: ToolsEnvRecord[],
	secretId: string,
): ToolsEnvRecord[] {
	return envs.filter(
		(env) => env.kind === "local-daemon" && env.secretId === secretId,
	);
}

function envUsageLabel(env: ToolsEnvRecord): string {
	return env.label ? `${env.label} (${env.envId})` : env.envId;
}

function revokeConfirmMessage(
	secret: ToolsEnvSecretMetaRecord,
	users: ToolsEnvRecord[],
): string {
	const name = secret.label ?? secret.secretId;
	const envList =
		users.length === 0
			? "No local-daemon envs use this secret."
			: `Daemon envs that will disconnect: ${users.map(envUsageLabel).join(", ")}.`;
	return `Revoke pairing secret ${name} (${secret.secretId})? The token stops working immediately. ${envList}`;
}

const OWNER_REVOKE_HINT = "Only account owners can revoke";
const OWNER_REVOKE_ERROR = "Only account owners can revoke pairing secrets";

function revokeFailureMessage(error: {
	code?: string;
	message?: string;
}): string {
	if (error.code === "forbidden") return OWNER_REVOKE_ERROR;
	return error.message ?? "Failed to revoke pairing secret";
}

function daemonConnectionLabel(env: ToolsEnvRecord): string {
	if (env.kind === "just-bash") return " · connected";
	const status = env.connection?.status ?? "disconnected";
	const when = env.connection?.connectedAt
		? ` · connectedAt ${new Date(env.connection.connectedAt).toISOString()}`
		: "";
	const error = env.connection?.lastError
		? ` · error ${env.connection.lastError}`
		: "";
	return ` · ${status}${when}${error}`;
}

export function ToolsEnvSettings({ isOpen, onClose }: ToolsEnvSettingsProps) {
	const { client } = useCadmus();
	const [envs, setEnvs] = useState<ToolsEnvRecord[]>([]);
	const [defaultEnvId, setDefaultEnvId] = useState("");
	const [secrets, setSecrets] = useState<ToolsEnvSecretMetaRecord[]>([]);
	const [canRevoke, setCanRevoke] = useState<boolean | null>(null);
	const [mintedToken, setMintedToken] = useState<string | null>(null);
	const [pairingInfo, setPairingInfo] = useState<{
		command: string;
		expiresAt: number;
	} | null>(null);
	const [copied, setCopied] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const [jbLabel, setJbLabel] = useState("");
	const [jbPersist, setJbPersist] = useState(true);
	const [jbShared, setJbShared] = useState(false);

	const [daemonLabel, setDaemonLabel] = useState("");
	const [daemonPath, setDaemonPath] = useState("");
	const [daemonPersist, setDaemonPersist] = useState(true);
	const [daemonConfine, setDaemonConfine] = useState(true);
	const [daemonSecretId, setDaemonSecretId] = useState("");

	const reload = useCallback(async () => {
		const [listed, secretList, memberList] = await Promise.all([
			client.callRpc("account.toolsEnvs.list"),
			client.callRpc("account.toolsEnvSecrets.list"),
			client.callRpc("account.members.list"),
		]);
		if (listed.ok && listed.result) {
			setEnvs(listed.result.envs);
			setDefaultEnvId(listed.result.default?.envId ?? "");
		}
		if (secretList.ok && secretList.result) {
			setSecrets(secretList.result.secrets);
		}
		if (memberList.ok && memberList.result) {
			const me = memberList.result.members.find(
				(member) => member.userId === client.getUserId(),
			);
			setCanRevoke(me ? me.role === "owner" : null);
		} else {
			setCanRevoke(null);
		}
	}, [client]);

	useEffect(() => {
		if (!isOpen) return;
		void reload();
		return client.subscribe((event) => {
			if (event.type === "account.tools_env_secret") {
				void reload();
			}
		});
	}, [isOpen, client, reload]);

	if (!isOpen) return null;

	const saveDefault = async (event: React.FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const res = await client.callRpc("account.update", {
				defaultToolsEnv: defaultEnvId ? { envId: defaultEnvId } : null,
			});
			if (!res.ok) {
				setError(res.error?.message ?? "Failed to update the account default");
				return;
			}
			await reload();
		} finally {
			setBusy(false);
		}
	};

	const createJustBash = async (event: React.FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const res = await client.callRpc("account.toolsEnvs.create", {
				kind: "just-bash",
				label: jbLabel.trim() || undefined,
				persist: jbPersist,
				sharedWorkspace: jbShared,
				confineToWorkspace: true,
			});
			if (!res.ok) {
				setError(res.error?.message ?? "Failed to create just-bash env");
				return;
			}
			setJbLabel("");
			await reload();
		} finally {
			setBusy(false);
		}
	};

	const mintSecret = async () => {
		setBusy(true);
		setError(null);
		try {
			const res = await client.callRpc("account.toolsEnvSecrets.set", {});
			if (!res.ok || !res.result) {
				setError(res.error?.message ?? "Failed to mint a pairing token");
				return;
			}
			setMintedToken(res.result.token);
			setDaemonSecretId(res.result.secret.secretId);
			await reload();
		} finally {
			setBusy(false);
		}
	};

	const revokeSecret = async (secret: ToolsEnvSecretMetaRecord) => {
		if (canRevoke === false) return;
		const users = daemonEnvsUsingSecret(envs, secret.secretId);
		if (
			typeof window === "undefined" ||
			!window.confirm(revokeConfirmMessage(secret, users))
		) {
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const res = await client.callRpc("account.toolsEnvSecrets.delete", {
				secretId: secret.secretId,
			});
			if (!res.ok) {
				setError(
					revokeFailureMessage(
						res.error ?? { message: "Failed to revoke pairing secret" },
					),
				);
				return;
			}
			await reload();
		} finally {
			setBusy(false);
		}
	};

	const createDaemon = async (event: React.FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const baseUrl =
				typeof window !== "undefined" ? window.location.origin : undefined;
			const res = await client.callRpc("account.toolsEnvs.create", {
				kind: "local-daemon",
				label: daemonLabel.trim() || undefined,
				workspacePath: daemonPath.trim(),
				persist: daemonPersist,
				confineToWorkspace: daemonConfine,
				secretId: daemonSecretId || undefined,
				baseUrl,
			});
			if (!res.ok) {
				setError(res.error?.message ?? "Failed to create daemon env");
				return;
			}
			setDaemonLabel("");
			setDaemonPath("");
			if (res.result?.command && res.result?.expiresAt) {
				setPairingInfo({
					command: res.result.command,
					expiresAt: res.result.expiresAt,
				});
			}
			await reload();
		} finally {
			setBusy(false);
		}
	};

	const pairDaemon = async (env: ToolsEnvRecord) => {
		setBusy(true);
		setError(null);
		try {
			const baseUrl =
				typeof window !== "undefined" ? window.location.origin : undefined;
			const res = await client.callRpc("account.toolsEnvs.pair", {
				envId: env.envId,
				baseUrl,
			});
			if (!res.ok || !res.result) {
				setError(res.error?.message ?? "Failed to generate pairing token");
				return;
			}
			setPairingInfo({
				command: res.result.command,
				expiresAt: res.result.expiresAt,
			});
		} finally {
			setBusy(false);
		}
	};

	const deregisterDaemon = async (env: ToolsEnvRecord) => {
		if (
			typeof window !== "undefined" &&
			!window.confirm(
				`Deregister daemon ${env.label || env.envId}? Active connections will be terminated and the daemon must be paired again to reconnect.`,
			)
		) {
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const res = await client.callRpc("account.toolsEnvs.deregister", {
				envId: env.envId,
			});
			if (!res.ok) {
				setError(res.error?.message ?? "Failed to deregister daemon");
				return;
			}
			await reload();
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="modal-backdrop">
			<button
				type="button"
				className="modal-backdrop-dismiss"
				onClick={onClose}
				aria-label="Close dialog"
			/>
			<div
				className="modal-container"
				role="dialog"
				aria-modal="true"
				style={{ position: "relative", zIndex: 1, maxWidth: "640px" }}
			>
				<div className="modal-header">
					<h3 className="modal-title">Account tools envs</h3>
					<button
						type="button"
						className="btn btn-ghost btn-sm"
						onClick={onClose}
						aria-label="Close dialog"
					>
						✕
					</button>
				</div>
				<div className="modal-body">
					{error ? (
						<div
							className="alert-banner alert-error"
							style={{ marginBottom: 12 }}
						>
							{error}
						</div>
					) : null}
					{pairingInfo ? (
						<div
							className="alert-banner"
							style={{
								marginBottom: 16,
								padding: "12px 14px",
								background: "rgba(16, 185, 129, 0.1)",
								borderRadius: 6,
								border: "1px solid var(--accent-emerald, #10b981)",
							}}
						>
							<div
								style={{
									display: "flex",
									justifyContent: "space-between",
									alignItems: "center",
									marginBottom: 6,
								}}
							>
								<strong style={{ color: "var(--accent-emerald, #10b981)" }}>
									Pairing Token Generated (Valid for 15 minutes)
								</strong>
								<button
									type="button"
									className="btn btn-ghost btn-sm"
									onClick={() => setPairingInfo(null)}
									aria-label="Dismiss pairing banner"
								>
									✕
								</button>
							</div>
							<p style={{ margin: "0 0 8px 0", fontSize: "0.85em" }}>
								Run this command on your machine to register the daemon:
							</p>
							<div style={{ display: "flex", gap: 8, alignItems: "center" }}>
								<code
									className="input-mono"
									style={{
										flex: 1,
										padding: "6px 8px",
										background: "rgba(0, 0, 0, 0.4)",
										borderRadius: 4,
										overflowX: "auto",
										whiteSpace: "nowrap",
									}}
								>
									{pairingInfo.command}
								</code>
								<button
									type="button"
									className="btn btn-secondary btn-sm"
									onClick={() => {
										void navigator.clipboard.writeText(pairingInfo.command);
										setCopied(true);
										setTimeout(() => setCopied(false), 2000);
									}}
								>
									{copied ? "Copied!" : "Copy Command"}
								</button>
							</div>
						</div>
					) : null}
					{mintedToken ? (
						<div className="alert-banner" style={{ marginBottom: 12 }}>
							Pairing token (shown once):{" "}
							<code className="input-mono">{mintedToken}</code>
						</div>
					) : null}
					<form onSubmit={saveDefault}>
						<div className="form-group">
							<label className="form-label" htmlFor="account-default-env">
								Account default
							</label>
							<select
								id="account-default-env"
								className="select input-mono"
								value={defaultEnvId}
								onChange={(event) => setDefaultEnvId(event.target.value)}
							>
								<option value="">None</option>
								{envs.map((env) => (
									<option key={env.envId} value={env.envId}>
										{env.envId} · {env.kind}
										{daemonConnectionLabel(env)}
									</option>
								))}
							</select>
							<span className="form-hint">
								None leaves inheriting bots unbound. jb_default is the built-in
								just-bash env.
							</span>
						</div>
						<button
							type="submit"
							className="btn btn-primary btn-sm"
							disabled={busy}
						>
							Save default
						</button>
					</form>

					<ul style={{ margin: "16px 0", paddingLeft: 18 }}>
						{envs.map((env) => (
							<li key={env.envId} style={{ marginBottom: 8 }}>
								<div
									style={{
										display: "flex",
										justifyContent: "space-between",
										alignItems: "center",
									}}
								>
									<div>
										<code>{env.envId}</code> {env.kind}
										{env.label ? ` (${env.label})` : ""}
										{env.workspacePath ? ` · ${env.workspacePath}` : ""}
										{daemonConnectionLabel(env)}
										{env.secretMissing &&
										env.connection?.lastError !== "secret_missing"
											? " · [unpaired]"
											: ""}
									</div>
									{env.kind === "local-daemon" ? (
										<div style={{ display: "flex", gap: 6 }}>
											<button
												type="button"
												className="btn btn-secondary btn-sm"
												onClick={() => void pairDaemon(env)}
												disabled={busy}
											>
												{env.secretId ? "Re-pair" : "Pair"}
											</button>
											{env.secretId ? (
												<button
													type="button"
													className="btn btn-danger btn-sm"
													onClick={() => void deregisterDaemon(env)}
													disabled={busy}
												>
													Deregister
												</button>
											) : null}
										</div>
									) : null}
								</div>
							</li>
						))}
					</ul>

					<section aria-label="Pairing secrets" style={{ marginTop: 16 }}>
						<h4>Pairing secrets</h4>
						{canRevoke === false ? (
							<p className="form-hint">{OWNER_REVOKE_HINT}</p>
						) : null}
						{secrets.length === 0 ? (
							<p className="form-hint">No pairing secrets.</p>
						) : (
							<ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
								{secrets.map((secret) => {
									const users = daemonEnvsUsingSecret(envs, secret.secretId);
									return (
										<li key={secret.secretId} style={{ marginBottom: 10 }}>
											<div>
												<strong>{secret.label ?? secret.secretId}</strong>
												{" · "}
												<code>{secret.secretId}</code>
											</div>
											<div className="form-hint">
												created{" "}
												{secret.createdAt
													? formatTimestamp(secret.createdAt)
													: "unknown"}
												{" · "}
												last used{" "}
												{secret.lastUsedAt
													? formatTimestamp(secret.lastUsedAt)
													: "never"}
											</div>
											<div className="form-hint">
												{users.length === 0
													? "No local-daemon envs use this secret."
													: `Daemon envs: ${users.map(envUsageLabel).join(", ")}`}
											</div>
											<button
												type="button"
												className="btn btn-danger btn-sm"
												aria-label={`Revoke pairing secret ${secret.secretId}`}
												onClick={() => void revokeSecret(secret)}
												disabled={busy || canRevoke === false}
											>
												Revoke
											</button>
										</li>
									);
								})}
							</ul>
						)}
					</section>

					<form onSubmit={createJustBash}>
						<h4>Create just-bash env</h4>
						<div className="form-group">
							<label className="form-label" htmlFor="jb-label">
								Label
							</label>
							<input
								id="jb-label"
								className="input"
								value={jbLabel}
								onChange={(event) => setJbLabel(event.target.value)}
							/>
						</div>
						<label htmlFor="jb-persist">
							<input
								id="jb-persist"
								type="checkbox"
								checked={jbPersist}
								onChange={(event) => setJbPersist(event.target.checked)}
							/>{" "}
							persist
						</label>
						<label htmlFor="jb-shared" style={{ marginLeft: 12 }}>
							<input
								id="jb-shared"
								type="checkbox"
								checked={jbShared}
								onChange={(event) => setJbShared(event.target.checked)}
							/>{" "}
							sharedWorkspace
						</label>
						<p className="form-hint">just-bash confinement is on.</p>
						<button
							type="submit"
							className="btn btn-secondary btn-sm"
							disabled={busy}
						>
							Create just-bash env
						</button>
					</form>

					<form onSubmit={createDaemon} style={{ marginTop: 16 }}>
						<h4>Create local-daemon env</h4>
						<div className="form-group">
							<label className="form-label" htmlFor="daemon-path">
								Workspace path
							</label>
							<input
								id="daemon-path"
								className="input input-mono"
								value={daemonPath}
								onChange={(event) => setDaemonPath(event.target.value)}
								required
							/>
						</div>
						<div className="form-group">
							<label className="form-label" htmlFor="daemon-secret">
								Pairing secret
							</label>
							<select
								id="daemon-secret"
								className="select input-mono"
								value={daemonSecretId}
								onChange={(event) => setDaemonSecretId(event.target.value)}
							>
								<option value="">
									Auto-generate pairing token (Recommended)
								</option>
								{secrets.map((secret) => (
									<option key={secret.secretId} value={secret.secretId}>
										{secret.label
											? `${secret.label} (${secret.secretId})`
											: secret.secretId}
									</option>
								))}
							</select>
						</div>
						<label htmlFor="daemon-persist">
							<input
								id="daemon-persist"
								type="checkbox"
								checked={daemonPersist}
								onChange={(event) => setDaemonPersist(event.target.checked)}
							/>{" "}
							persist
						</label>
						<label htmlFor="daemon-confine" style={{ marginLeft: 12 }}>
							<input
								id="daemon-confine"
								type="checkbox"
								checked={daemonConfine}
								onChange={(event) => setDaemonConfine(event.target.checked)}
							/>{" "}
							confineToWorkspace
						</label>
						<div className="form-group">
							<label className="form-label" htmlFor="daemon-label">
								Label
							</label>
							<input
								id="daemon-label"
								className="input"
								value={daemonLabel}
								onChange={(event) => setDaemonLabel(event.target.value)}
							/>
						</div>
						<div style={{ display: "flex", gap: 8 }}>
							<button
								type="button"
								className="btn btn-secondary btn-sm"
								onClick={() => void mintSecret()}
								disabled={busy}
							>
								Mint pairing token
							</button>
							<button
								type="submit"
								className="btn btn-primary btn-sm"
								disabled={busy || !daemonPath.trim()}
							>
								Create & Pair Daemon
							</button>
						</div>
					</form>
				</div>
			</div>
		</div>
	);
}
