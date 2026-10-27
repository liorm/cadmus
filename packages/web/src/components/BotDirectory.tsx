import type { BotRecord, ThinkingLevel } from "@cadmus/contract/types";
import { useEffect, useMemo, useState } from "react";
import { useCadmus } from "../context/CadmusContext.js";
import {
	buildToolsEnvSetting,
	EMPTY_TOOLS_ALLOWLIST_HINT,
	formatToolsEnvSummary,
	type ToolsEnvCatalogChoice,
	type ToolsEnvChoice,
	toolsFormBaseline,
	toolsPayload,
	toolsPayloadForEdit,
} from "../tools-env-form.js";
import { ToolsEnvPinFields } from "./ToolsEnvPinFields.js";

const THINKING_LEVELS: ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

interface BotModalProps {
	isOpen: boolean;
	mode: "create" | "edit";
	bot?: BotRecord | null;
	onClose: () => void;
}

export function botToolSummary(tools: readonly string[] | undefined): string {
	if (tools === undefined) return "All tools permitted";
	if (tools.length === 0) return "No tools permitted";
	return `${tools.length} tools: ${tools.slice(0, 3).join(", ")}${tools.length > 3 ? "..." : ""}`;
}

export function BotModal({ isOpen, mode, bot, onClose }: BotModalProps) {
	const { client, refreshBots, selectBot, models, openCredentials } =
		useCadmus();

	const [name, setName] = useState(bot?.name ?? "");
	const [slug, setSlug] = useState(bot?.id ?? "");
	const [model, setModel] = useState(bot?.model ?? "faux/echo");
	const [thinking, setThinking] = useState<ThinkingLevel>(
		bot?.thinking ?? "off",
	);
	const initialTools = toolsFormBaseline(bot?.tools);
	const [tools, setTools] = useState(initialTools.toolsText);
	const [soul, setSoul] = useState("");
	const [codingTools, setCodingTools] = useState(initialTools.includeCoding);
	const [toolsTouched, setToolsTouched] = useState(false);
	const [toolsEnvChoice, setToolsEnvChoice] = useState<ToolsEnvChoice>(
		bot?.toolsEnv == null ? "inherit" : bot.toolsEnv.enabled ? "on" : "off",
	);
	const [toolsEnvId, setToolsEnvId] = useState(
		bot?.toolsEnv?.binding?.envId ?? "",
	);
	const [envChoices, setEnvChoices] = useState<ToolsEnvCatalogChoice[]>([]);
	const [effectiveSummary, setEffectiveSummary] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setToolsTouched(false);
		if (!isOpen) return;
		let cancelled = false;
		void (async () => {
			const listed = await client.callRpc("account.toolsEnvs.list");
			if (!cancelled && listed.ok && listed.result) {
				setEnvChoices(
					listed.result.envs.map((env) => ({
						envId: env.envId,
						kind: env.kind,
						...(env.label ? { label: env.label } : {}),
					})),
				);
			}
			if (!bot) return;
			const view = await client.callRpc("bot.get", { botId: bot.id });
			if (cancelled || !view.ok || !view.result) return;
			setEffectiveSummary(
				formatToolsEnvSummary({
					stored: view.result.bot.toolsEnv ?? null,
					enabled: view.result.toolsEnvEnabled,
					enabledSource: view.result.toolsEnvEnabledSource,
					bindingSource: view.result.toolsEnvBindingSource,
					effective: view.result.effectiveToolsEnv,
					status: view.result.toolsEnvStatus,
					connectedAt: view.result.toolsEnvConnectedAt,
					lastError: view.result.toolsEnvLastError,
				}),
			);
		})();
		return () => {
			cancelled = true;
		};
	}, [isOpen, bot, client]);

	const availableModels = useMemo(() => {
		const list = ["faux/echo"];
		for (const m of models) {
			const fullId = m.id.includes("/") ? m.id : `${m.provider}/${m.id}`;
			if (!list.includes(fullId)) {
				list.push(fullId);
			}
		}
		if (bot?.model && !list.includes(bot.model)) {
			list.push(bot.model);
		}
		return list;
	}, [models, bot?.model]);

	if (!isOpen) return null;

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!name.trim()) return;

		setIsSubmitting(true);
		setError(null);
		try {
			const toolsEnv = buildToolsEnvSetting({
				choice: toolsEnvChoice,
				envId: toolsEnvId,
				retainEnvId: bot?.toolsEnv?.binding?.envId,
			});

			if (mode === "create") {
				const res = await client.callRpc("bot.create", {
					name: name.trim(),
					slug: slug.trim() || undefined,
					model: model.trim() || undefined,
					thinking,
					tools: toolsPayload(tools, codingTools, "create"),
					soul: soul.trim() || undefined,
					toolsEnv,
				});

				if (!res.ok) {
					setError(res.error?.message ?? "Failed to create bot persona");
					return;
				}

				await refreshBots();
				if (res.result?.bot?.id) {
					selectBot(res.result.bot.id);
				}
				onClose();
			} else if (bot) {
				const res = await client.callRpc("bot.update", {
					botId: bot.id,
					name: name.trim() || undefined,
					model: model.trim() || undefined,
					thinking,
					tools: toolsPayloadForEdit(
						tools,
						codingTools,
						initialTools,
						bot.tools,
						toolsTouched,
					),
					soul: soul.trim() || undefined,
					toolsEnv,
				});

				if (!res.ok) {
					setError(res.error?.message ?? "Failed to update bot persona");
					return;
				}

				await refreshBots();
				onClose();
			}
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to save bot persona",
			);
		} finally {
			setIsSubmitting(false);
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
				style={{ position: "relative", zIndex: 1, maxWidth: "560px" }}
			>
				<div className="modal-header">
					<h3 className="modal-title">
						{mode === "create"
							? "Create New Bot Persona"
							: `Edit Bot: ${bot?.name}`}
					</h3>
					<button
						type="button"
						className="btn btn-ghost btn-sm"
						onClick={onClose}
						aria-label="Close dialog"
					>
						✕
					</button>
				</div>
				<form onSubmit={handleSubmit}>
					<div className="modal-body">
						{error && (
							<div
								className="alert-banner alert-error"
								style={{ marginBottom: "12px" }}
							>
								{error}
							</div>
						)}

						<div className="form-group">
							<label className="form-label" htmlFor="bot-name">
								Bot Name *
							</label>
							<input
								id="bot-name"
								className="input"
								type="text"
								placeholder="e.g. Research Assistant"
								value={name}
								onChange={(e) => setName(e.target.value)}
								required
							/>
						</div>

						{mode === "create" ? (
							<div className="form-group">
								<label className="form-label" htmlFor="bot-slug">
									Bot ID / Slug
								</label>
								<input
									id="bot-slug"
									className="input input-mono"
									type="text"
									placeholder="e.g. researcher (auto-generated if empty)"
									value={slug}
									onChange={(e) => setSlug(e.target.value)}
								/>
								<span className="form-hint">
									Unique slug within the family. Used in URLs and chat routing.
								</span>
							</div>
						) : (
							<div className="form-group">
								<label className="form-label" htmlFor="bot-id-readonly">
									Bot ID
								</label>
								<input
									id="bot-id-readonly"
									className="input input-mono"
									type="text"
									value={bot?.id ?? ""}
									disabled
									readOnly
								/>
							</div>
						)}

						<div className="form-group">
							<div
								style={{
									display: "flex",
									justifyContent: "space-between",
									alignItems: "center",
								}}
							>
								<label className="form-label" htmlFor="bot-model">
									LLM Model
								</label>
								<button
									type="button"
									className="btn btn-ghost btn-sm"
									style={{
										fontSize: "11px",
										padding: "2px 6px",
										height: "auto",
									}}
									onClick={() =>
										openCredentials(
											model.includes("/") ? model.split("/")[0] : undefined,
										)
									}
									title="Configure AI provider credentials"
								>
									🔑 AI Providers
								</button>
							</div>
							<select
								id="bot-model"
								className="select input-mono"
								value={model}
								onChange={(e) => setModel(e.target.value)}
							>
								{availableModels.map((m) => (
									<option key={m} value={m}>
										{m === "faux/echo"
											? "faux/echo (offline deterministic)"
											: m}
									</option>
								))}
							</select>
							<span className="form-hint">
								Model used for conversation turns. "faux/echo" runs offline
								without API keys.
								{model.startsWith("xai") && (
									<span
										style={{
											display: "block",
											marginTop: "4px",
											color: "var(--accent-cyan)",
										}}
									>
										Requires xAI authorization. Click "AI Providers" to sign in
										with SuperGrok / X Premium or enter an API key.
									</span>
								)}
							</span>
						</div>

						<div className="form-group">
							<label className="form-label" htmlFor="bot-thinking">
								Extended Thinking Level
							</label>
							<select
								id="bot-thinking"
								className="select"
								value={thinking}
								onChange={(e) => setThinking(e.target.value as ThinkingLevel)}
							>
								{THINKING_LEVELS.map((lvl) => (
									<option key={lvl} value={lvl}>
										{lvl}
									</option>
								))}
							</select>
							<span className="form-hint">
								Budget for model reasoning / chain of thought before responding.
							</span>
						</div>

						<div className="form-group">
							<label className="form-label" htmlFor="bot-tools">
								Permitted Tools (comma-separated)
							</label>
							<input
								id="bot-tools"
								className="input input-mono"
								type="text"
								placeholder="e.g. knowledge_read, memory_update (blank for all)"
								value={tools}
								onChange={(e) => {
									setToolsTouched(true);
									setTools(e.target.value);
								}}
							/>
							<span className="form-hint">
								{mode === "edit" && bot?.tools?.length === 0
									? EMPTY_TOOLS_ALLOWLIST_HINT
									: "Optional list of tool names allowed for this bot. Leave blank to allow all tools. Coding tools stay opt-in."}
							</span>
						</div>

						<div className="form-group">
							<label className="form-label" htmlFor="bot-coding-tools">
								<input
									id="bot-coding-tools"
									type="checkbox"
									checked={codingTools}
									onChange={(event) => {
										setToolsTouched(true);
										setCodingTools(event.target.checked);
									}}
								/>{" "}
								Coding tools (bash, read, write, edit)
							</label>
							<span className="form-hint">
								Off by default. Env Off still hides these tools on inheriting
								chats.
							</span>
						</div>

						<ToolsEnvPinFields
							idPrefix="bot-tools-env"
							choice={toolsEnvChoice}
							envId={toolsEnvId}
							envs={envChoices}
							retainedEnvId={bot?.toolsEnv?.binding?.envId}
							onChoice={setToolsEnvChoice}
							onEnvId={setToolsEnvId}
						/>
						{effectiveSummary ? (
							<p className="form-hint">{effectiveSummary}</p>
						) : null}

						<div className="form-group">
							<label className="form-label" htmlFor="bot-soul">
								Initial System Prompt (SOUL.md)
							</label>
							<textarea
								id="bot-soul"
								className="textarea textarea-mono"
								rows={4}
								placeholder="You are an autonomous AI assistant specialized in..."
								value={soul}
								onChange={(e) => setSoul(e.target.value)}
							/>
							<span className="form-hint">
								System prompt instructions defining bot personality and goals.
							</span>
						</div>
					</div>
					<div className="modal-footer">
						<button
							type="button"
							className="btn btn-secondary"
							onClick={onClose}
							disabled={isSubmitting}
						>
							Cancel
						</button>
						<button
							type="submit"
							className="btn btn-primary"
							disabled={isSubmitting || !name.trim()}
						>
							{isSubmitting
								? "Saving..."
								: mode === "create"
									? "Create Bot"
									: "Save Changes"}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}

interface DeleteConfirmModalProps {
	isOpen: boolean;
	bot: BotRecord | null;
	onClose: () => void;
}

function DeleteConfirmModal({ isOpen, bot, onClose }: DeleteConfirmModalProps) {
	const { client, refreshBots } = useCadmus();
	const [isDeleting, setIsDeleting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (!isOpen || !bot) return null;

	const handleDelete = async () => {
		setIsDeleting(true);
		setError(null);
		try {
			const res = await client.callRpc("bot.delete", { botId: bot.id });
			if (!res.ok) {
				setError(res.error?.message ?? "Failed to delete bot");
				return;
			}
			await refreshBots();
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to delete bot");
		} finally {
			setIsDeleting(false);
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
				style={{ position: "relative", zIndex: 1, maxWidth: "460px" }}
			>
				<div className="modal-header">
					<h3 className="modal-title" style={{ color: "var(--accent-rose)" }}>
						Delete Bot: {bot.name}
					</h3>
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
					{error && (
						<div
							className="alert-banner alert-error"
							style={{ marginBottom: "12px" }}
						>
							{error}
						</div>
					)}
					<p style={{ color: "var(--text-primary)", marginBottom: "12px" }}>
						Are you sure you want to permanently delete{" "}
						<strong>{bot.name}</strong> (<code>{bot.id}</code>)?
					</p>
					<p style={{ fontSize: "12px", color: "var(--text-muted)" }}>
						This action cannot be undone. All conversation threads, virtual
						workspace files (SOUL.md, MEMORY.md, knowledge documents), and
						schedules for this bot will be cascade-deleted.
					</p>
				</div>
				<div className="modal-footer">
					<button
						type="button"
						className="btn btn-secondary"
						onClick={onClose}
						disabled={isDeleting}
					>
						Cancel
					</button>
					<button
						type="button"
						className="btn btn-danger"
						onClick={handleDelete}
						disabled={isDeleting}
					>
						{isDeleting ? "Deleting..." : "Permanently Delete"}
					</button>
				</div>
			</div>
		</div>
	);
}

export function BotDirectory() {
	const { bots, selectedBot, selectBot } = useCadmus();

	const [isCreateOpen, setIsCreateOpen] = useState(false);
	const [editingBot, setEditingBot] = useState<BotRecord | null>(null);
	const [deletingBot, setDeletingBot] = useState<BotRecord | null>(null);

	return (
		<div className="bots-list-sidebar">
			<div className="panel-header">
				<div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
					<span className="panel-title">Bots & Personas</span>
					<span className="badge badge-indigo">{bots.length}</span>
				</div>
				<button
					type="button"
					className="btn btn-primary btn-sm"
					onClick={() => setIsCreateOpen(true)}
					title="Create new bot persona"
				>
					+ New Bot
				</button>
			</div>

			<div className="panel-body" style={{ padding: "0" }}>
				{bots.length === 0 ? (
					<div
						className="empty-state"
						style={{ padding: "32px 16px", textAlign: "center" }}
					>
						<span style={{ fontSize: "24px" }}>🤖</span>
						<p
							style={{
								fontSize: "13px",
								fontWeight: 600,
								color: "var(--text-primary)",
								marginTop: "8px",
							}}
						>
							No Bots Found
						</p>
						<p style={{ fontSize: "12px", color: "var(--text-muted)" }}>
							Click "+ New Bot" above to provision a persona in this family.
						</p>
					</div>
				) : (
					bots.map((bot) => {
						const isSelected = selectedBot?.id === bot.id;
						const toolSummary = botToolSummary(bot.tools);

						return (
							<div
								key={bot.id}
								className={`bot-item-card ${isSelected ? "active" : ""}`}
							>
								<div
									style={{
										display: "flex",
										alignItems: "flex-start",
										justifyContent: "space-between",
										marginBottom: "6px",
									}}
								>
									<button
										type="button"
										onClick={() => selectBot(bot.id)}
										style={{
											background: "none",
											border: "none",
											textAlign: "left",
											cursor: "pointer",
											padding: 0,
											color: "inherit",
											flex: 1,
										}}
									>
										<div
											style={{
												fontWeight: 600,
												fontSize: "13px",
												color: isSelected
													? "var(--accent-cyan)"
													: "var(--text-primary)",
											}}
										>
											{bot.name}
										</div>
										<div
											style={{
												fontSize: "11px",
												color: "var(--text-muted)",
												fontFamily: "var(--font-mono)",
											}}
										>
											{bot.id}
										</div>
									</button>

									<div style={{ display: "flex", gap: "4px" }}>
										<button
											type="button"
											className="btn btn-ghost btn-sm"
											style={{ padding: "2px 6px", fontSize: "11px" }}
											onClick={(e) => {
												e.stopPropagation();
												setEditingBot(bot);
											}}
											title="Edit bot persona"
										>
											✏️ Edit
										</button>
										<button
											type="button"
											className="btn btn-ghost btn-sm"
											style={{
												padding: "2px 6px",
												fontSize: "11px",
												color: "var(--accent-rose)",
											}}
											onClick={(e) => {
												e.stopPropagation();
												setDeletingBot(bot);
											}}
											title="Delete bot persona"
										>
											🗑
										</button>
									</div>
								</div>

								{/* Metadata badges row - also clickable to select */}
								<button
									type="button"
									onClick={() => selectBot(bot.id)}
									style={{
										background: "none",
										border: "none",
										textAlign: "left",
										cursor: "pointer",
										padding: 0,
										color: "inherit",
										width: "100%",
									}}
								>
									<div
										style={{
											display: "flex",
											flexWrap: "wrap",
											alignItems: "center",
											gap: "4px",
											marginBottom: "6px",
										}}
									>
										<span
											className="badge badge-cyan"
											style={{ fontFamily: "var(--font-mono)" }}
											title="Default Turn Model"
										>
											{bot.model}
										</span>

										<span
											className="badge badge-amber"
											title="Reasoning / Thinking Level"
										>
											think: {bot.thinking}
										</span>

										{bot.timezone && (
											<span className="badge" title="Timezone">
												{bot.timezone}
											</span>
										)}
									</div>

									{/* Tool permissions summary */}
									<div
										style={{
											fontSize: "11px",
											color: "var(--text-secondary)",
											display: "flex",
											alignItems: "center",
											gap: "4px",
										}}
									>
										<span style={{ opacity: 0.7 }}>🛠</span>
										<span
											style={{
												overflow: "hidden",
												textOverflow: "ellipsis",
												whiteSpace: "nowrap",
											}}
										>
											{toolSummary}
										</span>
									</div>
								</button>
							</div>
						);
					})
				)}
			</div>

			{/* Create Bot Modal */}
			<BotModal
				isOpen={isCreateOpen}
				mode="create"
				onClose={() => setIsCreateOpen(false)}
			/>

			{/* Edit Bot Modal */}
			{editingBot && (
				<BotModal
					isOpen={true}
					mode="edit"
					bot={editingBot}
					onClose={() => setEditingBot(null)}
				/>
			)}

			{/* Delete Confirmation Modal */}
			{deletingBot && (
				<DeleteConfirmModal
					isOpen={true}
					bot={deletingBot}
					onClose={() => setDeletingBot(null)}
				/>
			)}
		</div>
	);
}
