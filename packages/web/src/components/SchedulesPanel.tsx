import type {
	BotRecord,
	ScheduleRecord,
	ScheduleTarget,
	ThinkingLevel,
} from "@cadmus/contract/types";
import { useCallback, useEffect, useState } from "react";
import { useCadmus } from "../context/CadmusContext.js";

const THINKING_LEVELS: ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

interface ScheduleModalProps {
	isOpen: boolean;
	mode: "create" | "edit";
	schedule?: ScheduleRecord | null;
	bots: BotRecord[];
	defaultBotId?: string;
	onClose: () => void;
	onSaved: () => Promise<void>;
}

function ScheduleModal({
	isOpen,
	mode,
	schedule,
	bots,
	defaultBotId,
	onClose,
	onSaved,
}: ScheduleModalProps) {
	const { client } = useCadmus();

	const [botId, setBotId] = useState(
		schedule?.botId ?? defaultBotId ?? bots[0]?.id ?? "",
	);
	const [name, setName] = useState(schedule?.name ?? "");
	const [kind, setKind] = useState<"relative" | "absolute" | "cron">(
		schedule?.kind ?? "cron",
	);
	const [input, setInput] = useState(
		schedule?.input !== undefined ? String(schedule.input) : "0 9 * * *",
	);
	const [targetMode, setTargetMode] = useState<"chat" | "new-chat" | "fork">(
		schedule?.target.mode ?? "new-chat",
	);
	const [targetChatKey, setTargetChatKey] = useState(
		schedule?.target.mode === "chat" || schedule?.target.mode === "fork"
			? schedule.target.chatKey
			: "",
	);
	const [targetAt, setTargetAt] = useState(
		schedule?.target.mode === "fork" && schedule.target.at !== undefined
			? String(schedule.target.at)
			: "",
	);
	const [thinking, setThinking] = useState<string>(schedule?.thinking ?? "");
	const [text, setText] = useState(schedule?.text ?? "");
	const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Sync when schedule changes
	useEffect(() => {
		if (mode === "edit" && schedule) {
			setBotId(schedule.botId);
			setName(schedule.name ?? "");
			setKind(schedule.kind);
			setInput(String(schedule.input));
			setTargetMode(schedule.target.mode);
			setTargetChatKey(
				schedule.target.mode === "chat" || schedule.target.mode === "fork"
					? schedule.target.chatKey
					: "",
			);
			setTargetAt(
				schedule.target.mode === "fork" && schedule.target.at !== undefined
					? String(schedule.target.at)
					: "",
			);
			setThinking(schedule.thinking ?? "");
			setText(schedule.text);
			setEnabled(schedule.enabled);
		} else if (mode === "create") {
			setBotId(defaultBotId || bots[0]?.id || "");
			setName("");
			setKind("cron");
			setInput("0 9 * * *");
			setTargetMode("new-chat");
			setTargetChatKey("");
			setTargetAt("");
			setThinking("");
			setText("");
			setEnabled(true);
		}
		setError(null);
	}, [mode, schedule, defaultBotId, bots]);

	if (!isOpen) return null;

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!text.trim()) {
			setError("Prompt text is required");
			return;
		}
		if (!input.trim()) {
			setError("Timing expression is required");
			return;
		}
		if (mode === "create" && !botId.trim()) {
			setError("Bot ID is required");
			return;
		}
		if (
			(targetMode === "chat" || targetMode === "fork") &&
			!targetChatKey.trim()
		) {
			setError("Target chatKey is required for chat or fork modes");
			return;
		}

		let target: ScheduleTarget;
		if (targetMode === "new-chat") {
			target = { mode: "new-chat" };
		} else if (targetMode === "fork") {
			target = {
				mode: "fork",
				chatKey: targetChatKey.trim(),
				...(targetAt.trim() ? { at: Number(targetAt.trim()) } : {}),
			};
		} else {
			target = {
				mode: "chat",
				chatKey: targetChatKey.trim(),
			};
		}

		setIsSubmitting(true);
		setError(null);
		try {
			if (mode === "create") {
				const res = await client.callRpc("schedule.create", {
					botId: botId.trim(),
					name: name.trim() || undefined,
					kind,
					input: input.trim(),
					text: text.trim(),
					target,
					thinking: thinking ? (thinking as ThinkingLevel) : undefined,
					enabled,
				});
				if (!res.ok) {
					setError(res.error?.message ?? "Failed to create schedule");
					return;
				}
			} else if (schedule) {
				const res = await client.callRpc("schedule.update", {
					id: schedule.id,
					name: name.trim() || undefined,
					kind,
					input: input.trim(),
					text: text.trim(),
					target,
					thinking: thinking ? (thinking as ThinkingLevel) : undefined,
					enabled,
				});
				if (!res.ok) {
					setError(res.error?.message ?? "Failed to update schedule");
					return;
				}
			}
			await onSaved();
			onClose();
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to persist schedule",
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
				<form onSubmit={handleSubmit}>
					<div className="modal-header">
						<h3 className="modal-title">
							{mode === "create"
								? "Create Scheduled Task"
								: `Edit Schedule: ${schedule?.name || schedule?.id}`}
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

						{mode === "create" ? (
							<div className="form-group">
								<label className="form-label" htmlFor="schedule-bot-select">
									Target Bot *
								</label>
								<select
									id="schedule-bot-select"
									className="select"
									value={botId}
									onChange={(e) => setBotId(e.target.value)}
									required
								>
									{bots.map((b) => (
										<option key={b.id} value={b.id}>
											{b.name} ({b.id})
										</option>
									))}
								</select>
							</div>
						) : (
							<div className="form-group">
								<label className="form-label" htmlFor="schedule-bot-readonly">
									Bot ID
								</label>
								<input
									id="schedule-bot-readonly"
									className="input input-mono"
									type="text"
									value={botId}
									disabled
									readOnly
								/>
							</div>
						)}

						<div className="form-group">
							<label className="form-label" htmlFor="schedule-name">
								Schedule Name / Label (optional)
							</label>
							<input
								id="schedule-name"
								className="input"
								type="text"
								placeholder="e.g. Daily Standup Briefing"
								value={name}
								onChange={(e) => setName(e.target.value)}
							/>
						</div>

						<div
							style={{
								display: "grid",
								gridTemplateColumns: "1fr 2fr",
								gap: "12px",
							}}
						>
							<div className="form-group">
								<label className="form-label" htmlFor="schedule-kind">
									Timing Kind *
								</label>
								<select
									id="schedule-kind"
									className="select"
									value={kind}
									onChange={(e) =>
										setKind(e.target.value as "relative" | "absolute" | "cron")
									}
								>
									<option value="cron">cron (recurring)</option>
									<option value="relative">relative (one-shot delay)</option>
									<option value="absolute">absolute (date/time)</option>
								</select>
							</div>

							<div className="form-group">
								<label className="form-label" htmlFor="schedule-input">
									Timing Expression (input) *
								</label>
								<input
									id="schedule-input"
									className="input input-mono"
									type="text"
									placeholder={
										kind === "cron"
											? "0 9 * * * or @hourly"
											: kind === "relative"
												? "30s, 5m, or 1h"
												: "2026-10-25T12:00:00Z"
									}
									value={input}
									onChange={(e) => setInput(e.target.value)}
									required
								/>
							</div>
						</div>

						<div
							style={{
								display: "grid",
								gridTemplateColumns: "1fr 2fr",
								gap: "12px",
							}}
						>
							<div className="form-group">
								<label className="form-label" htmlFor="schedule-target-mode">
									Target Mode *
								</label>
								<select
									id="schedule-target-mode"
									className="select"
									value={targetMode}
									onChange={(e) =>
										setTargetMode(
											e.target.value as "chat" | "new-chat" | "fork",
										)
									}
								>
									<option value="new-chat">new-chat</option>
									<option value="chat">chat (existing)</option>
									<option value="fork">fork</option>
								</select>
							</div>

							{(targetMode === "chat" || targetMode === "fork") && (
								<div className="form-group">
									<label className="form-label" htmlFor="schedule-target-chat">
										Chat Key *
									</label>
									<input
										id="schedule-target-chat"
										className="input input-mono"
										type="text"
										placeholder="e.g. chat-1"
										value={targetChatKey}
										onChange={(e) => setTargetChatKey(e.target.value)}
										required
									/>
								</div>
							)}
						</div>

						{targetMode === "fork" && (
							<div className="form-group">
								<label className="form-label" htmlFor="schedule-target-at">
									Fork Watermark Entry # (optional)
								</label>
								<input
									id="schedule-target-at"
									className="input input-mono"
									type="number"
									placeholder="Entry sequence watermark (e.g. 10)"
									value={targetAt}
									onChange={(e) => setTargetAt(e.target.value)}
								/>
							</div>
						)}

						<div className="form-group">
							<label className="form-label" htmlFor="schedule-thinking">
								Thinking Level (optional)
							</label>
							<select
								id="schedule-thinking"
								className="select"
								value={thinking}
								onChange={(e) => setThinking(e.target.value)}
							>
								<option value="">Default (inherit from bot)</option>
								{THINKING_LEVELS.map((lvl) => (
									<option key={lvl} value={lvl}>
										{lvl}
									</option>
								))}
							</select>
						</div>

						<div className="form-group">
							<label className="form-label" htmlFor="schedule-prompt">
								Prompt Text *
							</label>
							<textarea
								id="schedule-prompt"
								className="textarea"
								style={{ minHeight: "90px" }}
								placeholder="Enter the prompt text sent to the bot when triggered..."
								value={text}
								onChange={(e) => setText(e.target.value)}
								required
							/>
						</div>

						<div className="form-group" style={{ marginTop: "4px" }}>
							<label
								style={{
									display: "flex",
									alignItems: "center",
									gap: "8px",
									cursor: "pointer",
									fontSize: "13px",
								}}
							>
								<input
									type="checkbox"
									checked={enabled}
									onChange={(e) => setEnabled(e.target.checked)}
								/>
								<span>Schedule is enabled (active)</span>
							</label>
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
							disabled={isSubmitting}
						>
							{isSubmitting
								? "Saving..."
								: mode === "create"
									? "Create Schedule"
									: "Save Changes"}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}

interface DeleteScheduleModalProps {
	isOpen: boolean;
	schedule: ScheduleRecord | null;
	onClose: () => void;
	onDeleted: () => Promise<void>;
}

function DeleteScheduleModal({
	isOpen,
	schedule,
	onClose,
	onDeleted,
}: DeleteScheduleModalProps) {
	const { client } = useCadmus();
	const [isDeleting, setIsDeleting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (!isOpen || !schedule) return null;

	const handleDelete = async () => {
		setIsDeleting(true);
		setError(null);
		try {
			const res = await client.callRpc("schedule.delete", {
				id: schedule.id,
			});
			if (!res.ok) {
				setError(res.error?.message ?? "Failed to delete schedule");
				return;
			}
			await onDeleted();
			onClose();
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to delete schedule",
			);
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
						Delete Schedule: {schedule.name || schedule.id}
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
						Are you sure you want to permanently delete schedule{" "}
						<code>{schedule.id}</code>?
					</p>
					<p style={{ fontSize: "12px", color: "var(--text-muted)" }}>
						This action cannot be undone. Any pending alarm wakeup for this task
						will be canceled.
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

function formatTargetSummary(target: ScheduleTarget): string {
	if (target.mode === "chat") {
		return `chat: ${target.chatKey}`;
	}
	if (target.mode === "new-chat") {
		return "new-chat";
	}
	if (target.mode === "fork") {
		const watermark = target.at !== undefined ? ` @ #${target.at}` : "";
		const harvest = target.harvest ? " (harvest)" : "";
		return `fork: ${target.chatKey}${watermark}${harvest}`;
	}
	return (target as { mode: string }).mode;
}

export interface SchedulesPanelProps {
	initialSchedules?: ScheduleRecord[];
	initialFilterBotId?: string;
	initialIncludeInternal?: boolean;
}

export function SchedulesPanel({
	initialSchedules,
	initialFilterBotId = "",
	initialIncludeInternal = false,
}: SchedulesPanelProps) {
	const { client, bots } = useCadmus();

	const [schedules, setSchedules] = useState<ScheduleRecord[]>(
		initialSchedules ?? [],
	);
	const [filterBotId, setFilterBotId] = useState<string>(initialFilterBotId);
	const [includeInternal, setIncludeInternal] = useState<boolean>(
		initialIncludeInternal,
	);
	const [isLoading, setIsLoading] = useState<boolean>(false);
	const [error, setError] = useState<string | null>(null);

	const [isCreateOpen, setIsCreateOpen] = useState(false);
	const [editingSchedule, setEditingSchedule] = useState<ScheduleRecord | null>(
		null,
	);
	const [deletingSchedule, setDeletingSchedule] =
		useState<ScheduleRecord | null>(null);

	const fetchSchedules = useCallback(async () => {
		setIsLoading(true);
		setError(null);
		try {
			const res = await client.callRpc("schedule.list", {
				...(filterBotId ? { botId: filterBotId } : {}),
				includeInternal,
			});
			if (res.ok && res.result?.schedules) {
				setSchedules(res.result.schedules);
			} else if (res.error) {
				setError(res.error.message);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load schedules");
		} finally {
			setIsLoading(false);
		}
	}, [client, filterBotId, includeInternal]);

	useEffect(() => {
		if (initialSchedules === undefined) {
			void fetchSchedules();
		}
	}, [fetchSchedules, initialSchedules]);

	const handleToggleEnable = async (sched: ScheduleRecord) => {
		try {
			const res = await client.callRpc("schedule.update", {
				id: sched.id,
				enabled: !sched.enabled,
			});
			if (res.ok) {
				await fetchSchedules();
			} else if (res.error) {
				setError(res.error.message);
			}
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to toggle schedule",
			);
		}
	};

	return (
		<section className="schedules-pane" aria-label="Schedules Manager">
			{/* Header Controls */}
			<div className="schedules-pane-header">
				<div
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						gap: "8px",
						flexWrap: "wrap",
					}}
				>
					<div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
						<span style={{ fontSize: "16px" }}>⏰</span>
						<h2
							style={{
								fontSize: "15px",
								fontWeight: 600,
								color: "var(--text-primary)",
							}}
						>
							Scheduled Tasks
						</h2>
						<span className="badge badge-ghost">{schedules.length}</span>
					</div>

					<div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
						<button
							type="button"
							className="btn btn-secondary btn-sm"
							onClick={fetchSchedules}
							disabled={isLoading}
							title="Refresh schedules list"
						>
							↻ Refresh
						</button>
						<button
							type="button"
							className="btn btn-primary btn-sm"
							onClick={() => setIsCreateOpen(true)}
						>
							+ New Schedule
						</button>
					</div>
				</div>

				<div
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						gap: "12px",
						flexWrap: "wrap",
					}}
				>
					{/* Bot Filter */}
					<div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
						<label
							htmlFor="schedules-bot-filter"
							style={{ fontSize: "12px", color: "var(--text-secondary)" }}
						>
							Bot:
						</label>
						<select
							id="schedules-bot-filter"
							className="select"
							style={{ width: "180px", height: "30px", fontSize: "12px" }}
							value={filterBotId}
							onChange={(e) => setFilterBotId(e.target.value)}
						>
							<option value="">All Bots</option>
							{bots.map((b) => (
								<option key={b.id} value={b.id}>
									{b.name} ({b.id})
								</option>
							))}
						</select>
					</div>

					{/* Show internal harvest timers checkbox */}
					<label
						style={{
							display: "flex",
							alignItems: "center",
							gap: "6px",
							cursor: "pointer",
							fontSize: "12px",
							color: "var(--text-secondary)",
						}}
					>
						<input
							type="checkbox"
							checked={includeInternal}
							onChange={(e) => setIncludeInternal(e.target.checked)}
						/>
						<span>Show internal harvest timers</span>
					</label>
				</div>
			</div>

			{/* Main Schedule List Content */}
			<div className="schedules-pane-content">
				{error && (
					<div
						className="alert-banner alert-error"
						style={{ marginBottom: "8px" }}
					>
						{error}
					</div>
				)}

				{schedules.length === 0 ? (
					<div className="empty-state">
						<span className="empty-icon">⏰</span>
						<h3>No Scheduled Tasks</h3>
						<p>
							{filterBotId
								? "No schedules found matching this bot filter."
								: "No recurring cron tasks or one-shot timers registered yet."}
						</p>
						<button
							type="button"
							className="btn btn-secondary btn-sm"
							style={{ marginTop: "8px" }}
							onClick={() => setIsCreateOpen(true)}
						>
							+ Create First Schedule
						</button>
					</div>
				) : (
					schedules.map((sched) => {
						const nextRunDate = new Date(sched.nextRun);
						const formattedNextRun = !Number.isNaN(nextRunDate.getTime())
							? nextRunDate.toLocaleString()
							: String(sched.nextRun);

						return (
							<article key={sched.id} className="schedule-card">
								<div className="schedule-card-header">
									<div className="schedule-card-title">
										<span>{sched.name || sched.id}</span>
										<code
											className="badge badge-ghost"
											style={{
												fontFamily: "var(--font-mono)",
												fontSize: "11px",
											}}
										>
											{sched.id}
										</code>
										<span className="badge badge-indigo">{sched.botId}</span>
										<span className="badge badge-cyan">{sched.kind}</span>
										{sched.recurring && (
											<span className="badge badge-emerald">recurring</span>
										)}
										{sched.internal && (
											<span className="badge badge-amber">internal</span>
										)}
										<span
											className={`badge ${sched.enabled ? "badge-emerald" : "badge-ghost"}`}
										>
											{sched.enabled ? "Enabled" : "Disabled"}
										</span>
									</div>
								</div>

								<div className="schedule-card-body">
									<div className="schedule-meta-row">
										<span>
											Expression:{" "}
											<code
												style={{
													fontFamily: "var(--font-mono)",
													color: "var(--accent-cyan)",
												}}
											>
												{String(sched.input)}
											</code>
										</span>
										<span>•</span>
										<span>
											Target:{" "}
											<strong style={{ color: "var(--text-primary)" }}>
												{formatTargetSummary(sched.target)}
											</strong>
										</span>
										{sched.thinking && (
											<>
												<span>•</span>
												<span className="badge badge-ghost">
													{`thinking: ${sched.thinking}`}
												</span>
											</>
										)}
									</div>

									<div className="schedule-meta-row">
										<span>Next Run: {formattedNextRun}</span>
										{sched.inSeconds !== undefined && (
											<span className="badge badge-ghost">
												{sched.inSeconds > 0
													? `in ${sched.inSeconds}s`
													: `${Math.abs(sched.inSeconds)}s ago`}
											</span>
										)}
									</div>

									<div className="schedule-prompt-preview">
										<span
											style={{
												color: "var(--text-muted)",
												marginRight: "6px",
											}}
										>
											Prompt:
										</span>
										{sched.text}
									</div>
								</div>

								<div className="schedule-card-actions">
									<button
										type="button"
										className="btn btn-secondary btn-sm"
										onClick={() => handleToggleEnable(sched)}
									>
										{sched.enabled ? "Disable" : "Enable"}
									</button>
									<button
										type="button"
										className="btn btn-secondary btn-sm"
										onClick={() => setEditingSchedule(sched)}
									>
										Edit
									</button>
									<button
										type="button"
										className="btn btn-danger btn-sm"
										onClick={() => setDeletingSchedule(sched)}
									>
										Delete
									</button>
								</div>
							</article>
						);
					})
				)}
			</div>

			{/* Create Modal */}
			<ScheduleModal
				isOpen={isCreateOpen}
				mode="create"
				bots={bots}
				defaultBotId={filterBotId || bots[0]?.id}
				onClose={() => setIsCreateOpen(false)}
				onSaved={fetchSchedules}
			/>

			{/* Edit Modal */}
			<ScheduleModal
				isOpen={Boolean(editingSchedule)}
				mode="edit"
				schedule={editingSchedule}
				bots={bots}
				onClose={() => setEditingSchedule(null)}
				onSaved={fetchSchedules}
			/>

			{/* Delete Modal */}
			<DeleteScheduleModal
				isOpen={Boolean(deletingSchedule)}
				schedule={deletingSchedule}
				onClose={() => setDeletingSchedule(null)}
				onDeleted={fetchSchedules}
			/>
		</section>
	);
}
