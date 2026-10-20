import { useCallback, useEffect, useMemo, useState } from "react";
import type {
	FileListItem,
	FileReadDocResult,
	KnowledgeSearchResult,
} from "../../../src/protocol.js";
import { useCadmus } from "../context/CadmusContext.js";

function formatBytes(bytes?: number): string {
	if (bytes === undefined || bytes === null) return "";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface NewKnowledgeModalProps {
	isOpen: boolean;
	botId: string;
	onClose: () => void;
	onCreated: (path: string) => void;
}

function NewKnowledgeModal({
	isOpen,
	botId,
	onClose,
	onCreated,
}: NewKnowledgeModalProps) {
	const { client } = useCadmus();
	const [slug, setSlug] = useState("");
	const [description, setDescription] = useState("");
	const [category, setCategory] = useState("");
	const [body, setBody] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (!isOpen) return null;

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		const cleanSlug = slug
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9-]/g, "-");
		if (!cleanSlug || !description.trim()) return;

		setIsSubmitting(true);
		setError(null);
		const filePath = `knowledge/${cleanSlug}.md`;

		try {
			const res = await client.callRpc("file.write", {
				botId,
				path: filePath,
				description: description.trim(),
				category: category.trim() || undefined,
				body,
				expectedVersion: 0,
			});

			if (!res.ok) {
				setError(res.error?.message ?? "Failed to create knowledge document");
				return;
			}

			onCreated(filePath);
			onClose();
		} catch (err) {
			setError(
				err instanceof Error
					? err.message
					: "Failed to create knowledge document",
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
				style={{ position: "relative", zIndex: 1, maxWidth: "600px" }}
			>
				<div className="modal-header">
					<h3 className="modal-title">+ New Knowledge Document</h3>
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
							<label className="form-label" htmlFor="doc-slug">
								Document Slug (Filename) *
							</label>
							<input
								id="doc-slug"
								className="input input-mono"
								type="text"
								placeholder="e.g. system-architecture"
								value={slug}
								onChange={(e) => setSlug(e.target.value)}
								required
							/>
							<span className="form-hint">
								Will be saved as <code>knowledge/&lt;slug&gt;.md</code>.
							</span>
						</div>

						<div className="form-group">
							<label className="form-label" htmlFor="doc-description">
								Description / Summary *
							</label>
							<input
								id="doc-description"
								className="input"
								type="text"
								placeholder="e.g. Architectural overview and durable task invariants"
								value={description}
								onChange={(e) => setDescription(e.target.value)}
								required
							/>
							<span className="form-hint">
								Used by agent model tools to decide when to retrieve this doc.
							</span>
						</div>

						<div className="form-group">
							<label className="form-label" htmlFor="doc-category">
								Category (Optional)
							</label>
							<input
								id="doc-category"
								className="input"
								type="text"
								placeholder="e.g. architecture, guides, api"
								value={category}
								onChange={(e) => setCategory(e.target.value)}
							/>
						</div>

						<div className="form-group">
							<label className="form-label" htmlFor="doc-body">
								Markdown Content Body
							</label>
							<textarea
								id="doc-body"
								className="textarea textarea-mono"
								rows={8}
								placeholder="# Architecture Overview&#10;&#10;Describe system components..."
								value={body}
								onChange={(e) => setBody(e.target.value)}
							/>
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
							disabled={isSubmitting || !slug.trim() || !description.trim()}
						>
							{isSubmitting ? "Creating..." : "Create Knowledge Doc"}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}

interface DeleteFileModalProps {
	isOpen: boolean;
	botId: string;
	path: string;
	version: number;
	onClose: () => void;
	onDeleted: () => void;
}

function DeleteFileModal({
	isOpen,
	botId,
	path,
	version,
	onClose,
	onDeleted,
}: DeleteFileModalProps) {
	const { client } = useCadmus();
	const [isDeleting, setIsDeleting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (!isOpen) return null;

	const handleDelete = async () => {
		setIsDeleting(true);
		setError(null);
		try {
			const res = await client.callRpc("file.delete", {
				botId,
				path,
				expectedVersion: version,
			});

			if (!res.ok) {
				setError(res.error?.message ?? "Failed to delete file");
				return;
			}

			onDeleted();
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to delete file");
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
						Delete Knowledge File
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
						Are you sure you want to delete <code>{path}</code> (version{" "}
						{version}
						)?
					</p>
					<p style={{ fontSize: "12px", color: "var(--text-muted)" }}>
						This knowledge document will be removed from the bot's workspace and
						search index.
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
						{isDeleting ? "Deleting..." : "Delete File"}
					</button>
				</div>
			</div>
		</div>
	);
}

export function FileInspector() {
	const { selectedBot, client } = useCadmus();

	const [files, setFiles] = useState<FileListItem[]>([]);
	const [activePath, setActivePath] = useState<string>("SOUL.md");
	const [isLoadingFiles, setIsLoadingFiles] = useState(false);

	// Editor state
	const [currentContent, setCurrentContent] = useState("");
	const [currentBody, setCurrentBody] = useState("");
	const [currentDescription, setCurrentDescription] = useState("");
	const [currentCategory, setCurrentCategory] = useState("");
	const [currentVersion, setCurrentVersion] = useState<number>(1);
	const [isLoadingContent, setIsLoadingContent] = useState(false);
	const [isSaving, setIsSaving] = useState(false);
	const [statusBanner, setStatusBanner] = useState<{
		type: "success" | "error";
		text: string;
	} | null>(null);

	// Knowledge Search state
	const [searchQuery, setSearchQuery] = useState("");
	const [searchResults, setSearchResults] = useState<KnowledgeSearchResult[]>(
		[],
	);
	const [isSearching, setIsSearching] = useState(false);

	// Modals
	const [isNewKnowledgeOpen, setIsNewKnowledgeOpen] = useState(false);
	const [isDeleteOpen, setIsDeleteOpen] = useState(false);

	// Fetch files list for the selected bot
	const fetchFiles = useCallback(async () => {
		if (!selectedBot) {
			setFiles([]);
			return;
		}

		setIsLoadingFiles(true);
		try {
			const res = await client.callRpc("file.list", { botId: selectedBot.id });
			if (res.ok && res.result?.files) {
				setFiles(res.result.files);
			}
		} finally {
			setIsLoadingFiles(false);
		}
	}, [client, selectedBot]);

	// Reload files when selectedBot changes
	useEffect(() => {
		void fetchFiles();
		setActivePath("SOUL.md");
		setSearchQuery("");
		setSearchResults([]);
		setStatusBanner(null);
	}, [fetchFiles]);

	// Fetch single file content when activePath or selectedBot changes
	const fetchFileContent = useCallback(
		async (path: string) => {
			if (!selectedBot) return;

			setIsLoadingContent(true);
			setStatusBanner(null);
			try {
				const res = await client.callRpc("file.read", {
					botId: selectedBot.id,
					path,
				});

				if (res.ok && res.result && "content" in res.result) {
					const doc = res.result as FileReadDocResult;
					setCurrentContent(doc.content ?? doc.text ?? "");
					setCurrentBody(doc.body ?? doc.content ?? doc.text ?? "");
					setCurrentDescription(doc.description ?? "");
					setCurrentCategory(doc.category ?? "");
					setCurrentVersion(doc.version);
				} else {
					setStatusBanner({
						type: "error",
						text: res.error?.message ?? "Failed to read file",
					});
				}
			} catch (err) {
				setStatusBanner({
					type: "error",
					text: err instanceof Error ? err.message : "Error reading file",
				});
			} finally {
				setIsLoadingContent(false);
			}
		},
		[client, selectedBot],
	);

	useEffect(() => {
		if (selectedBot && activePath) {
			void fetchFileContent(activePath);
		}
	}, [fetchFileContent, selectedBot, activePath]);

	// Handle Knowledge Search
	useEffect(() => {
		if (!selectedBot || !searchQuery.trim()) {
			setSearchResults([]);
			return;
		}

		let active = true;
		setIsSearching(true);

		const timer = setTimeout(() => {
			client
				.callRpc("knowledge.search", {
					botId: selectedBot.id,
					query: searchQuery.trim(),
				})
				.then((res) => {
					if (!active) return;
					if (res.ok && res.result?.results) {
						setSearchResults(res.result.results);
					} else {
						setSearchResults([]);
					}
				})
				.catch(() => {
					if (active) setSearchResults([]);
				})
				.finally(() => {
					if (active) setIsSearching(false);
				});
		}, 200);

		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [client, selectedBot, searchQuery]);

	// Categorize files
	const { coreFiles, knowledgeFiles } = useMemo(() => {
		const core: FileListItem[] = [];
		const knowledge: FileListItem[] = [];

		for (const f of files) {
			if (f.kind === "knowledge" || f.path.startsWith("knowledge/")) {
				knowledge.push(f);
			} else {
				core.push(f);
			}
		}

		return { coreFiles: core, knowledgeFiles: knowledge };
	}, [files]);

	const activeFileItem = useMemo(() => {
		return files.find((f) => f.path === activePath) ?? null;
	}, [files, activePath]);

	const isKnowledgeFile =
		activePath.startsWith("knowledge/") || activeFileItem?.kind === "knowledge";

	// Handle Save with CAS versioning
	const handleSave = async () => {
		if (!selectedBot || !activePath) return;

		setIsSaving(true);
		setStatusBanner(null);

		try {
			if (isKnowledgeFile) {
				if (!currentDescription.trim()) {
					setStatusBanner({
						type: "error",
						text: "Knowledge docs require a summary description.",
					});
					setIsSaving(false);
					return;
				}

				const res = await client.callRpc("file.write", {
					botId: selectedBot.id,
					path: activePath,
					body: currentBody,
					description: currentDescription.trim(),
					category: currentCategory.trim() || undefined,
					expectedVersion: currentVersion,
				});

				if (!res.ok) {
					setStatusBanner({
						type: "error",
						text:
							res.error?.message ??
							"Failed to save file. Version conflict (CAS error).",
					});
					return;
				}

				const updatedVer =
					"version" in (res.result ?? {})
						? (res.result as { version: number }).version
						: currentVersion + 1;
				setCurrentVersion(updatedVer);
				setStatusBanner({
					type: "success",
					text: `Saved ${activePath} at version ${updatedVer}.`,
				});
				await fetchFiles();
			} else if (activePath === "SOUL.md") {
				const res = await client.callRpc("file.write", {
					botId: selectedBot.id,
					path: "SOUL.md",
					content: currentContent,
					expectedVersion: 1,
				});

				if (!res.ok) {
					setStatusBanner({
						type: "error",
						text: res.error?.message ?? "Failed to save SOUL.md",
					});
					return;
				}

				setStatusBanner({
					type: "success",
					text: "SOUL.md system prompt updated successfully.",
				});
				await fetchFiles();
			} else if (activePath === "MEMORY.md") {
				const res = await client.callRpc("file.write", {
					botId: selectedBot.id,
					path: "MEMORY.md",
					content: currentContent,
					expectedVersion: currentVersion,
				});

				if (!res.ok) {
					setStatusBanner({
						type: "error",
						text:
							res.error?.message ??
							"Failed to save MEMORY.md. Optimistic version conflict.",
					});
					return;
				}

				const updatedVer =
					"version" in (res.result ?? {})
						? (res.result as { version: number }).version
						: currentVersion + 1;
				setCurrentVersion(updatedVer);
				setStatusBanner({
					type: "success",
					text: `MEMORY.md saved at version ${updatedVer}.`,
				});
				await fetchFiles();
			}
		} catch (err) {
			setStatusBanner({
				type: "error",
				text: err instanceof Error ? err.message : "Error saving file",
			});
		} finally {
			setIsSaving(false);
		}
	};

	if (!selectedBot) {
		return (
			<div className="editor-main-area flex-center">
				<div className="empty-state">
					<span className="empty-icon">📂</span>
					<h3>No Bot Selected</h3>
					<p>
						Select a bot from the directory to inspect its virtual workspace
						files.
					</p>
				</div>
			</div>
		);
	}

	return (
		<div
			className="editor-main-area"
			style={{ display: "flex", flexDirection: "row" }}
		>
			{/* Left Column: Virtual Files Tree & Knowledge Search */}
			<div
				className="files-sidebar"
				style={{
					width: "290px",
					borderRight: "1px solid var(--border-subtle)",
					backgroundColor: "var(--bg-surface-0)",
					display: "flex",
					flexDirection: "column",
					flexShrink: 0,
					height: "100%",
				}}
			>
				<div className="panel-header">
					<div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
						<span className="panel-title">Virtual Files</span>
						<span className="badge badge-indigo">
							{isLoadingFiles ? "..." : files.length}
						</span>
					</div>
					<button
						type="button"
						className="btn btn-secondary btn-sm"
						onClick={() => setIsNewKnowledgeOpen(true)}
						title="Create new knowledge document"
					>
						+ New Doc
					</button>
				</div>

				{/* Search Knowledge Box */}
				<div
					style={{
						padding: "8px 12px",
						borderBottom: "1px solid var(--border-subtle)",
					}}
				>
					<input
						type="text"
						className="input"
						style={{ fontSize: "12px", padding: "5px 8px" }}
						placeholder="Search knowledge docs..."
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
					/>
				</div>

				{/* File List Navigation */}
				<div
					className="panel-body"
					style={{ padding: "8px 0", overflowY: "auto", flex: 1 }}
				>
					{searchQuery.trim() ? (
						// Search Results View
						<div>
							<div
								style={{
									padding: "4px 12px",
									fontSize: "11px",
									fontWeight: 600,
									color: "var(--text-muted)",
									textTransform: "uppercase",
									letterSpacing: "0.05em",
								}}
							>
								{isSearching
									? "Searching..."
									: `Matches (${searchResults.length})`}
							</div>
							{searchResults.length === 0 && !isSearching ? (
								<p
									style={{
										padding: "12px",
										fontSize: "12px",
										color: "var(--text-muted)",
										textAlign: "center",
									}}
								>
									No knowledge documents match "{searchQuery}"
								</p>
							) : (
								searchResults.map((res) => {
									const itemPath = `knowledge/${res.slug}.md`;
									const isSelected = activePath === itemPath;

									return (
										<button
											key={res.slug}
											type="button"
											className={`bot-item-card ${isSelected ? "active" : ""}`}
											onClick={() => setActivePath(itemPath)}
											style={{
												width: "100%",
												textAlign: "left",
												background: "none",
												border: "none",
												borderBottom: "1px solid var(--border-subtle)",
												padding: "8px 12px",
												cursor: "pointer",
												color: "inherit",
											}}
										>
											<div
												style={{
													fontWeight: 600,
													fontSize: "12px",
													color: isSelected
														? "var(--accent-cyan)"
														: "var(--text-primary)",
												}}
											>
												{res.slug}.md
											</div>
											{res.snippet && (
												<div
													style={{
														fontSize: "11px",
														color: "var(--text-secondary)",
														marginTop: "2px",
														lineHeight: 1.4,
													}}
												>
													{res.snippet}
												</div>
											)}
										</button>
									);
								})
							)}
						</div>
					) : (
						// Standard File List Groups
						<>
							{/* Core Personas & System Files */}
							<div
								style={{
									padding: "4px 12px",
									fontSize: "11px",
									fontWeight: 600,
									color: "var(--text-muted)",
									textTransform: "uppercase",
									letterSpacing: "0.05em",
								}}
							>
								Core Workspace
							</div>

							{coreFiles.map((file) => {
								const isSelected = activePath === file.path;
								const badgeClass =
									file.kind === "soul" ? "badge-indigo" : "badge-amber";

								return (
									<button
										key={file.path}
										type="button"
										className={`bot-item-card ${isSelected ? "active" : ""}`}
										onClick={() => setActivePath(file.path)}
										style={{
											width: "100%",
											textAlign: "left",
											background: "none",
											border: "none",
											borderBottom: "1px solid var(--border-subtle)",
											padding: "8px 12px",
											cursor: "pointer",
											color: "inherit",
										}}
									>
										<div
											style={{
												display: "flex",
												alignItems: "center",
												justifyContent: "space-between",
											}}
										>
											<div
												style={{
													fontWeight: 600,
													fontSize: "12px",
													fontFamily: "var(--font-mono)",
													color: isSelected
														? "var(--accent-cyan)"
														: "var(--text-primary)",
												}}
											>
												{file.kind === "soul" ? "🧠" : "💾"} {file.path}
											</div>
											<div
												style={{
													display: "flex",
													gap: "4px",
													alignItems: "center",
												}}
											>
												{file.version !== undefined && (
													<span
														className="badge"
														style={{ fontSize: "10px", padding: "1px 4px" }}
													>
														v{file.version}
													</span>
												)}
												<span
													className={`badge ${badgeClass}`}
													style={{ fontSize: "10px", padding: "1px 4px" }}
												>
													{file.kind}
												</span>
											</div>
										</div>
										<div
											style={{
												fontSize: "10px",
												color: "var(--text-muted)",
												marginTop: "2px",
											}}
										>
											{formatBytes(file.size)}
										</div>
									</button>
								);
							})}

							{/* Knowledge Documents */}
							<div
								style={{
									padding: "12px 12px 4px",
									fontSize: "11px",
									fontWeight: 600,
									color: "var(--text-muted)",
									textTransform: "uppercase",
									letterSpacing: "0.05em",
								}}
							>
								Knowledge Documents ({knowledgeFiles.length})
							</div>

							{knowledgeFiles.length === 0 ? (
								<p
									style={{
										padding: "8px 12px",
										fontSize: "11px",
										color: "var(--text-muted)",
									}}
								>
									No knowledge docs yet. Click "+ New Doc" to add one.
								</p>
							) : (
								knowledgeFiles.map((file) => {
									const isSelected = activePath === file.path;

									return (
										<button
											key={file.path}
											type="button"
											className={`bot-item-card ${isSelected ? "active" : ""}`}
											onClick={() => setActivePath(file.path)}
											style={{
												width: "100%",
												textAlign: "left",
												background: "none",
												border: "none",
												borderBottom: "1px solid var(--border-subtle)",
												padding: "8px 12px",
												cursor: "pointer",
												color: "inherit",
											}}
										>
											<div
												style={{
													display: "flex",
													alignItems: "center",
													justifyContent: "space-between",
												}}
											>
												<div
													style={{
														fontWeight: 600,
														fontSize: "12px",
														fontFamily: "var(--font-mono)",
														color: isSelected
															? "var(--accent-cyan)"
															: "var(--text-primary)",
														overflow: "hidden",
														textOverflow: "ellipsis",
														whiteSpace: "nowrap",
													}}
												>
													📚 {file.slug ?? file.path}
												</div>
												<div
													style={{
														display: "flex",
														gap: "4px",
														alignItems: "center",
													}}
												>
													{file.version !== undefined && (
														<span
															className="badge"
															style={{
																fontSize: "10px",
																padding: "1px 4px",
															}}
														>
															v{file.version}
														</span>
													)}
													{file.category && (
														<span
															className="badge badge-cyan"
															style={{
																fontSize: "10px",
																padding: "1px 4px",
															}}
														>
															{file.category}
														</span>
													)}
												</div>
											</div>
											{file.description && (
												<div
													style={{
														fontSize: "11px",
														color: "var(--text-secondary)",
														marginTop: "2px",
														overflow: "hidden",
														textOverflow: "ellipsis",
														whiteSpace: "nowrap",
													}}
													title={file.description}
												>
													{file.description}
												</div>
											)}
										</button>
									);
								})
							)}
						</>
					)}
				</div>
			</div>

			{/* Right Column: File Reader & Editor */}
			<div
				className="file-editor-area"
				style={{
					flex: 1,
					display: "flex",
					flexDirection: "column",
					height: "100%",
					backgroundColor: "var(--bg-canvas)",
					overflow: "hidden",
				}}
			>
				{/* Editor Header Bar */}
				<div
					className="editor-header"
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						padding: "10px 16px",
						backgroundColor: "var(--bg-surface-0)",
						borderBottom: "1px solid var(--border-subtle)",
						flexShrink: 0,
					}}
				>
					<div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
						<span
							style={{
								fontWeight: 600,
								fontFamily: "var(--font-mono)",
								fontSize: "14px",
							}}
						>
							{activePath}
						</span>

						<span
							className={`badge ${
								isKnowledgeFile
									? "badge-cyan"
									: activePath === "SOUL.md"
										? "badge-indigo"
										: "badge-amber"
							}`}
						>
							{isKnowledgeFile
								? "knowledge"
								: activePath === "SOUL.md"
									? "soul"
									: "memory"}
						</span>

						<span className="badge" title="Current CAS Version">
							v{currentVersion}
						</span>

						{activeFileItem?.size !== undefined && (
							<span className="badge" title="Size">
								{formatBytes(activeFileItem.size)}
							</span>
						)}
					</div>

					<div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
						<button
							type="button"
							className="btn btn-secondary btn-sm"
							onClick={() => void fetchFileContent(activePath)}
							disabled={isLoadingContent || isSaving}
							title="Reload file from server"
						>
							↻ Reload
						</button>

						{isKnowledgeFile && (
							<button
								type="button"
								className="btn btn-danger btn-sm"
								onClick={() => setIsDeleteOpen(true)}
								disabled={isLoadingContent || isSaving}
								title="Delete this knowledge document"
							>
								🗑 Delete
							</button>
						)}

						<button
							type="button"
							className="btn btn-primary btn-sm"
							onClick={handleSave}
							disabled={isLoadingContent || isSaving}
						>
							{isSaving ? "Saving..." : "Save File"}
						</button>
					</div>
				</div>

				{/* Status / Alert Banner */}
				{statusBanner && (
					<div
						className={`alert-banner ${
							statusBanner.type === "error" ? "alert-error" : "alert-success"
						}`}
						style={{ margin: "8px 16px 0" }}
					>
						{statusBanner.text}
					</div>
				)}

				{/* Knowledge-specific Metadata Fields */}
				{isKnowledgeFile && (
					<div
						style={{
							display: "grid",
							gridTemplateColumns: "1fr 200px",
							gap: "12px",
							padding: "12px 16px 0",
							flexShrink: 0,
						}}
					>
						<div>
							<label
								className="form-label"
								htmlFor="edit-description"
								style={{ marginBottom: "4px", display: "block" }}
							>
								Description * (used by tools to select this doc)
							</label>
							<input
								id="edit-description"
								className="input"
								style={{ fontSize: "12px", padding: "6px 8px" }}
								type="text"
								value={currentDescription}
								onChange={(e) => setCurrentDescription(e.target.value)}
								required
							/>
						</div>

						<div>
							<label
								className="form-label"
								htmlFor="edit-category"
								style={{ marginBottom: "4px", display: "block" }}
							>
								Category
							</label>
							<input
								id="edit-category"
								className="input"
								style={{ fontSize: "12px", padding: "6px 8px" }}
								type="text"
								placeholder="e.g. guides, api"
								value={currentCategory}
								onChange={(e) => setCurrentCategory(e.target.value)}
							/>
						</div>
					</div>
				)}

				{/* Textarea Content Editor */}
				<div
					style={{
						flex: 1,
						padding: "12px 16px 16px",
						display: "flex",
						flexDirection: "column",
						overflow: "hidden",
					}}
				>
					<textarea
						className="textarea textarea-mono"
						style={{
							flex: 1,
							resize: "none",
							lineHeight: 1.6,
							fontSize: "13px",
							backgroundColor: "#080c14",
							border: "1px solid var(--border-subtle)",
						}}
						value={isKnowledgeFile ? currentBody : currentContent}
						onChange={(e) => {
							if (isKnowledgeFile) {
								setCurrentBody(e.target.value);
							} else {
								setCurrentContent(e.target.value);
							}
						}}
						placeholder="File content..."
						disabled={isLoadingContent}
					/>
				</div>
			</div>

			{/* New Knowledge Doc Modal */}
			<NewKnowledgeModal
				isOpen={isNewKnowledgeOpen}
				botId={selectedBot.id}
				onClose={() => setIsNewKnowledgeOpen(false)}
				onCreated={(newPath) => {
					void fetchFiles().then(() => {
						setActivePath(newPath);
					});
				}}
			/>

			{/* Delete File Confirmation Modal */}
			<DeleteFileModal
				isOpen={isDeleteOpen}
				botId={selectedBot.id}
				path={activePath}
				version={currentVersion}
				onClose={() => setIsDeleteOpen(false)}
				onDeleted={() => {
					void fetchFiles().then(() => {
						setActivePath("SOUL.md");
					});
				}}
			/>
		</div>
	);
}
