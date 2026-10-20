import { useState } from "react";
import type { FamilyRecord } from "../../../src/protocol.js";
import {
	type ActiveTab,
	type DevAuthConfig,
	useCadmus,
} from "../context/CadmusContext.js";

interface SettingsModalProps {
	isOpen: boolean;
	onClose: () => void;
}

function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
	const { authConfig, updateAuthConfig } = useCadmus();
	const [form, setForm] = useState<DevAuthConfig>(authConfig);
	const [isSaving, setIsSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (!isOpen) return null;

	const handleSave = async (e: React.FormEvent) => {
		e.preventDefault();
		setIsSaving(true);
		setError(null);
		try {
			await updateAuthConfig(form);
			onClose();
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to update configuration",
			);
		} finally {
			setIsSaving(false);
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
				style={{ position: "relative", zIndex: 1 }}
			>
				<div className="modal-header">
					<h3 className="modal-title">Developer Auth & Connection Settings</h3>
					<button
						type="button"
						className="btn btn-ghost btn-sm"
						onClick={onClose}
						aria-label="Close settings"
					>
						✕
					</button>
				</div>
				<form onSubmit={handleSave}>
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
							<label className="form-label" htmlFor="dev-token">
								Bearer Token
							</label>
							<input
								id="dev-token"
								className="input input-mono"
								type="password"
								value={form.token}
								onChange={(e) =>
									setForm((prev) => ({ ...prev, token: e.target.value }))
								}
								required
							/>
							<span className="form-hint">
								Bearer token passed in Authorization header & WebSocket query.
							</span>
						</div>

						<div className="form-group">
							<label className="form-label" htmlFor="dev-account-id">
								Account ID
							</label>
							<input
								id="dev-account-id"
								className="input input-mono"
								type="text"
								value={form.accountId}
								onChange={(e) =>
									setForm((prev) => ({ ...prev, accountId: e.target.value }))
								}
								required
							/>
						</div>

						<div className="form-group">
							<label className="form-label" htmlFor="dev-family-id">
								Family ID
							</label>
							<input
								id="dev-family-id"
								className="input input-mono"
								type="text"
								value={form.familyId}
								onChange={(e) =>
									setForm((prev) => ({ ...prev, familyId: e.target.value }))
								}
								required
							/>
						</div>

						<div className="form-group">
							<label className="form-label" htmlFor="dev-user-id">
								User ID
							</label>
							<input
								id="dev-user-id"
								className="input input-mono"
								type="text"
								value={form.userId}
								onChange={(e) =>
									setForm((prev) => ({ ...prev, userId: e.target.value }))
								}
								required
							/>
						</div>
					</div>
					<div className="modal-footer">
						<button
							type="button"
							className="btn btn-secondary"
							onClick={onClose}
							disabled={isSaving}
						>
							Cancel
						</button>
						<button
							type="submit"
							className="btn btn-primary"
							disabled={isSaving}
						>
							{isSaving ? "Saving..." : "Save Settings"}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}

interface NewFamilyModalProps {
	isOpen: boolean;
	onClose: () => void;
}

function NewFamilyModal({ isOpen, onClose }: NewFamilyModalProps) {
	const { client, refreshFamilies, selectFamily } = useCadmus();
	const [name, setName] = useState("");
	const [familyId, setFamilyId] = useState("");
	const [timezone, setTimezone] = useState("UTC");
	const [harvestDelayMs, setHarvestDelayMs] = useState("60000");
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (!isOpen) return null;

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!name.trim()) return;

		setIsSubmitting(true);
		setError(null);
		try {
			const res = await client.callRpc("family.create", {
				name: name.trim(),
				familyId: familyId.trim() || undefined,
				timezone: timezone.trim() || undefined,
				harvestDelayMs: harvestDelayMs ? Number(harvestDelayMs) : undefined,
			});

			if (!res.ok) {
				setError(res.error?.message ?? "Failed to create bot family");
				return;
			}

			const createdId = res.result?.family?.familyId ?? familyId.trim();
			await refreshFamilies();
			if (createdId) {
				await selectFamily(createdId);
			}
			onClose();
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to create bot family",
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
				style={{ position: "relative", zIndex: 1 }}
			>
				<div className="modal-header">
					<h3 className="modal-title">Create New Bot Family</h3>
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
							<label className="form-label" htmlFor="family-name">
								Family Name *
							</label>
							<input
								id="family-name"
								className="input"
								type="text"
								placeholder="e.g. Production Bots"
								value={name}
								onChange={(e) => setName(e.target.value)}
								required
							/>
							<span className="form-hint">
								Human-readable display name for this bot family.
							</span>
						</div>

						<div className="form-group">
							<label className="form-label" htmlFor="family-slug">
								Family ID (Slug)
							</label>
							<input
								id="family-slug"
								className="input input-mono"
								type="text"
								placeholder="e.g. prod-bots (auto-generated if empty)"
								value={familyId}
								onChange={(e) => setFamilyId(e.target.value)}
							/>
							<span className="form-hint">
								Optional unique slug identifier. Used in Durable Object instance
								name.
							</span>
						</div>

						<div className="form-group">
							<label className="form-label" htmlFor="family-timezone">
								Timezone
							</label>
							<input
								id="family-timezone"
								className="input"
								type="text"
								placeholder="UTC"
								value={timezone}
								onChange={(e) => setTimezone(e.target.value)}
							/>
							<span className="form-hint">
								Default IANA timezone identifier (e.g. UTC,
								America/Los_Angeles).
							</span>
						</div>

						<div className="form-group">
							<label className="form-label" htmlFor="family-harvest-delay">
								Idle Harvest Delay (ms)
							</label>
							<input
								id="family-harvest-delay"
								className="input input-mono"
								type="number"
								min="1000"
								step="1000"
								value={harvestDelayMs}
								onChange={(e) => setHarvestDelayMs(e.target.value)}
							/>
							<span className="form-hint">
								Idle delay before running background memory/knowledge harvesting
								(default: 60000ms).
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
							{isSubmitting ? "Creating..." : "Create Family"}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}

interface FamilyInfoModalProps {
	isOpen: boolean;
	family: FamilyRecord | null;
	fallbackFamilyId: string;
	accountId: string;
	onClose: () => void;
}

function FamilyInfoModal({
	isOpen,
	family,
	fallbackFamilyId,
	accountId,
	onClose,
}: FamilyInfoModalProps) {
	const { client, refreshFamilies } = useCadmus();
	const activeFamilyId = family?.familyId ?? fallbackFamilyId;
	const [name, setName] = useState(family?.name ?? activeFamilyId);
	const [timezone, setTimezone] = useState(family?.timezone ?? "UTC");
	const [harvestDelayMs, setHarvestDelayMs] = useState(
		String(family?.harvestDelayMs ?? 60000),
	);
	const [isSaving, setIsSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (!isOpen) return null;

	const handleSave = async (e: React.FormEvent) => {
		e.preventDefault();
		setIsSaving(true);
		setError(null);
		try {
			const res = await client.callRpc("family.update", {
				familyId: activeFamilyId,
				name: name.trim() || undefined,
				timezone: timezone.trim() || undefined,
				harvestDelayMs: harvestDelayMs ? Number(harvestDelayMs) : undefined,
			});

			if (!res.ok) {
				setError(res.error?.message ?? "Failed to update family");
				return;
			}

			await refreshFamilies();
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to update family");
		} finally {
			setIsSaving(false);
		}
	};

	const doName = family?.doName ?? `cadmus:${accountId}:${activeFamilyId}`;

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
				style={{ position: "relative", zIndex: 1 }}
			>
				<div className="modal-header">
					<h3 className="modal-title">Bot Family Info & Configuration</h3>
					<button
						type="button"
						className="btn btn-ghost btn-sm"
						onClick={onClose}
						aria-label="Close dialog"
					>
						✕
					</button>
				</div>
				<form onSubmit={handleSave}>
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
							<label className="form-label" htmlFor="info-family-id">
								Family ID
							</label>
							<input
								id="info-family-id"
								className="input input-mono"
								type="text"
								value={activeFamilyId}
								disabled
								readOnly
							/>
						</div>

						<div className="form-group">
							<label className="form-label" htmlFor="info-do-name">
								Durable Object Name
							</label>
							<input
								id="info-do-name"
								className="input input-mono"
								type="text"
								value={doName}
								disabled
								readOnly
							/>
							<span className="form-hint">
								Deterministic Cloudflare DO instance ID backing this family.
							</span>
						</div>

						{family?.createdAt && (
							<div className="form-group">
								<label className="form-label" htmlFor="info-created-at">
									Created At
								</label>
								<input
									id="info-created-at"
									className="input input-mono"
									type="text"
									value={new Date(family.createdAt).toLocaleString()}
									disabled
									readOnly
								/>
							</div>
						)}

						<div className="form-group">
							<label className="form-label" htmlFor="info-name">
								Display Name
							</label>
							<input
								id="info-name"
								className="input"
								type="text"
								value={name}
								onChange={(e) => setName(e.target.value)}
								required
							/>
						</div>

						<div className="form-group">
							<label className="form-label" htmlFor="info-timezone">
								Timezone
							</label>
							<input
								id="info-timezone"
								className="input"
								type="text"
								value={timezone}
								onChange={(e) => setTimezone(e.target.value)}
							/>
						</div>

						<div className="form-group">
							<label className="form-label" htmlFor="info-harvest-delay">
								Idle Harvest Delay (ms)
							</label>
							<input
								id="info-harvest-delay"
								className="input input-mono"
								type="number"
								min="1000"
								step="1000"
								value={harvestDelayMs}
								onChange={(e) => setHarvestDelayMs(e.target.value)}
							/>
						</div>
					</div>
					<div className="modal-footer">
						<button
							type="button"
							className="btn btn-secondary"
							onClick={onClose}
							disabled={isSaving}
						>
							Cancel
						</button>
						<button
							type="submit"
							className="btn btn-primary"
							disabled={isSaving}
						>
							{isSaving ? "Saving..." : "Save Changes"}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}

export function TopBar() {
	const {
		connectionStatus,
		authConfig,
		families,
		currentFamily,
		selectFamily,
		activeTab,
		setActiveTab,
	} = useCadmus();

	const [isSettingsOpen, setIsSettingsOpen] = useState(false);
	const [isNewFamilyOpen, setIsNewFamilyOpen] = useState(false);
	const [isFamilyInfoOpen, setIsFamilyInfoOpen] = useState(false);

	const tabs: Array<{ id: ActiveTab; label: string; icon: string }> = [
		{ id: "chat", label: "Chat", icon: "💬" },
		{ id: "bots", label: "Bots & Files", icon: "🤖" },
		{ id: "schedules", label: "Schedules & Harvest", icon: "⏰" },
	];

	// Ensure the active familyId is selectable even before families list populates
	const activeFamilyId = currentFamily?.familyId ?? authConfig.familyId;
	const isCurrentInList = families.some((f) => f.familyId === activeFamilyId);

	return (
		<>
			{/* Top Bar Header */}
			<header className="top-bar">
				<div className="brand-section">
					<div className="brand-logo">
						<span className="brand-icon">⚡</span>
						<span>Cadmus</span>
					</div>
					<span className="brand-tag">Bot Family DO</span>

					<span
						className="badge badge-indigo"
						title="Authenticated Developer Identity"
					>
						{`${authConfig.userId} @ ${authConfig.accountId}`}
					</span>

					{/* Bot Family Picker */}
					<div
						className="family-picker-group"
						style={{ display: "flex", alignItems: "center", gap: "6px" }}
					>
						<select
							className="select"
							style={{ width: "200px", height: "30px", fontSize: "12px" }}
							value={activeFamilyId}
							onChange={(e) => void selectFamily(e.target.value)}
							aria-label="Select Bot Family"
						>
							{families.map((f) => (
								<option key={f.familyId} value={f.familyId}>
									{f.name} ({f.familyId})
								</option>
							))}
							{!isCurrentInList && (
								<option value={activeFamilyId}>
									{activeFamilyId} (active)
								</option>
							)}
						</select>

						<button
							type="button"
							className="btn btn-secondary btn-sm"
							onClick={() => setIsNewFamilyOpen(true)}
							title="Create a new bot family"
						>
							+ New Family
						</button>

						<button
							type="button"
							className="btn btn-secondary btn-sm"
							onClick={() => setIsFamilyInfoOpen(true)}
							title="Inspect and configure current bot family"
						>
							Family Info
						</button>
					</div>
				</div>

				<div className="top-bar-controls">
					<div className="status-pill">
						<span className={`status-dot ${connectionStatus}`} />
						<span style={{ textTransform: "capitalize" }}>
							{connectionStatus === "connected"
								? "Live WS"
								: connectionStatus === "connecting"
									? "Connecting"
									: "Offline"}
						</span>
					</div>

					<button
						type="button"
						className="btn btn-secondary btn-sm"
						onClick={() => setIsSettingsOpen(true)}
						title="Configure dev tokens, account ID, and endpoints"
					>
						⚙ Settings
					</button>
				</div>
			</header>

			{/* Navigation Tabs Bar */}
			<nav className="nav-tabs-bar" aria-label="Main Navigation">
				{tabs.map((tab) => (
					<button
						key={tab.id}
						type="button"
						className={`tab-button ${activeTab === tab.id ? "active" : ""}`}
						onClick={() => setActiveTab(tab.id)}
					>
						<span>{tab.icon}</span>
						<span>{tab.label}</span>
					</button>
				))}
			</nav>

			{/* Dialog Modals */}
			<SettingsModal
				isOpen={isSettingsOpen}
				onClose={() => setIsSettingsOpen(false)}
			/>
			<NewFamilyModal
				isOpen={isNewFamilyOpen}
				onClose={() => setIsNewFamilyOpen(false)}
			/>
			<FamilyInfoModal
				isOpen={isFamilyInfoOpen}
				family={currentFamily}
				fallbackFamilyId={authConfig.familyId}
				accountId={authConfig.accountId}
				onClose={() => setIsFamilyInfoOpen(false)}
			/>
		</>
	);
}
