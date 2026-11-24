import type {
	BotRecord,
	HarvestNote,
	RawTranscriptEntry,
} from "@cadmus/contract/types";
import { useNavigate } from "@tanstack/react-router";
import {
	BookOpen,
	Code2,
	FileText,
	History,
	Plus,
	SlidersHorizontal,
	Sparkles,
	X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ConfigPanel } from "@/components/ConfigPanel";
import { AddEntityDialog } from "@/components/chrome/AddEntityDialog";
import { HarvestView } from "@/components/HarvestView";
import { MarkdownFileView } from "@/components/MarkdownFileView";
import { RawTranscript } from "@/components/RawTranscript";
import { useCadmus } from "@/context/CadmusContext";
import { cn } from "@/lib/utils";

type VfsTab = "soul" | "memory" | "skills" | "harvest" | "config" | "raw";

const TABS: Array<{ id: VfsTab; label: string; icon: typeof FileText }> = [
	{ id: "soul", label: "SOUL", icon: FileText },
	{ id: "memory", label: "MEMORY", icon: BookOpen },
	{ id: "skills", label: "Skills", icon: Sparkles },
	{ id: "harvest", label: "Harvest", icon: History },
	{ id: "config", label: "Config", icon: SlidersHorizontal },
	{ id: "raw", label: "Raw", icon: Code2 },
];

export function CadmusVfsDrawer({
	open,
	onClose,
	bot,
	entries,
	notes,
}: {
	open: boolean;
	onClose: () => void;
	bot: BotRecord;
	entries: RawTranscriptEntry[];
	notes: HarvestNote[];
}) {
	const navigate = useNavigate();
	const { client, refreshDirectory } = useCadmus();
	const [tab, setTab] = useState<VfsTab>("soul");
	const [skillPaths, setSkillPaths] = useState<string[]>([]);
	const [selectedSkillPath, setSelectedSkillPath] = useState<string | null>(
		null,
	);
	const [skillsLoading, setSkillsLoading] = useState(false);
	const [addSkillOpen, setAddSkillOpen] = useState(false);
	const [newSkillSlug, setNewSkillSlug] = useState("");
	const [newSkillBody, setNewSkillBody] = useState(
		"---\ndescription: Describe when the bot should use this skill.\n---\n\n# New Skill\n\nDescribe the workflow, constraints, and checks.\n",
	);
	const [newSkillBusy, setNewSkillBusy] = useState(false);
	const [newSkillError, setNewSkillError] = useState<string | null>(null);

	const loadSkills = useCallback(async () => {
		setSkillsLoading(true);
		const res = await client.callRpc<{ files?: Array<{ path: string }> }>(
			"file.list",
			{ botId: bot.id },
		);
		setSkillsLoading(false);
		if (!res.ok) return;
		const paths = (res.result?.files ?? [])
			.map((f) => f.path)
			.filter((p) => p.startsWith("/.cadmus/skills/") && p.endsWith(".md"))
			.sort();
		setSkillPaths(paths);
		setSelectedSkillPath((prev) =>
			prev && paths.includes(prev) ? prev : (paths[0] ?? null),
		);
	}, [bot.id, client]);

	useEffect(() => {
		if (!open || tab !== "skills") return;
		void loadSkills();
	}, [open, tab, loadSkills]);

	if (!open) return null;

	async function handleCreateSkill(e: React.FormEvent) {
		e.preventDefault();
		const slug = newSkillSlug
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/^-+|-+$/g, "");
		if (!slug || newSkillBusy) return;
		const path = `/.cadmus/skills/${slug}/SKILL.md`;
		setNewSkillBusy(true);
		setNewSkillError(null);
		const res = await client.callRpc("file.write", {
			botId: bot.id,
			path,
			content: newSkillBody,
		});
		setNewSkillBusy(false);
		if (!res.ok) {
			setNewSkillError(res.error?.message ?? "Could not create skill file.");
			return;
		}
		setNewSkillSlug("");
		setAddSkillOpen(false);
		await loadSkills();
		setSelectedSkillPath(path);
	}

	return (
		<div className="fixed inset-0 z-40 flex justify-end bg-black/45 md:static md:inset-auto md:z-auto md:flex md:w-[440px] md:shrink-0 md:bg-transparent">
			<aside
				aria-label={`${bot.name} /.cadmus/ workspace`}
				className="flex h-full w-full flex-col border-l border-border bg-surface md:w-[440px]"
			>
				<header className="flex items-center justify-between border-b border-border px-3 py-2.5">
					<div className="min-w-0">
						<div className="truncate font-mono text-xs font-semibold text-accent">
							/.cadmus/ · {bot.name}
						</div>
						<div className="truncate text-[11px] text-text-muted">
							CAS-versioned bot files &amp; runtime state
						</div>
					</div>
					<button
						type="button"
						aria-label="Close /.cadmus/ drawer"
						onClick={onClose}
						className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-surface-raised hover:text-text"
					>
						<X className="h-4 w-4" />
					</button>
				</header>

				<nav
					aria-label="Bot VFS tabs"
					className="flex gap-1 overflow-x-auto border-b border-border px-2 py-1.5"
				>
					{TABS.map((item) => {
						const Icon = item.icon;
						const active = tab === item.id;
						return (
							<button
								key={item.id}
								type="button"
								onClick={() => setTab(item.id)}
								className={cn(
									"inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition",
									active
										? "bg-accent/15 text-accent"
										: "text-text-muted hover:bg-surface-raised hover:text-text",
								)}
							>
								<Icon className="h-3.5 w-3.5" />
								<span>{item.label}</span>
							</button>
						);
					})}
				</nav>

				<div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
					{tab === "soul" ? (
						<MarkdownFileView
							botId={bot.id}
							path="/.cadmus/SOUL.md"
							title="SOUL.md"
						/>
					) : tab === "memory" ? (
						<MarkdownFileView
							botId={bot.id}
							path="/.cadmus/MEMORY.md"
							title="MEMORY.md"
						/>
					) : tab === "skills" ? (
						<div className="flex flex-col gap-3">
							<div className="flex items-center justify-between gap-2">
								<span className="text-xs font-semibold text-text-muted">
									Bot skills ({skillPaths.length})
								</span>
								<button
									type="button"
									onClick={() => {
										setNewSkillError(null);
										setAddSkillOpen(true);
									}}
									className="inline-flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-xs font-semibold text-on-accent"
								>
									<Plus className="h-3.5 w-3.5" />
									Add skill
								</button>
							</div>
							{skillsLoading ? (
								<p className="text-xs text-text-muted">Loading skills…</p>
							) : skillPaths.length === 0 ? (
								<p className="rounded-lg border border-border bg-bg/50 p-3 text-xs text-text-muted">
									No procedural skills in /.cadmus/skills/ yet.
								</p>
							) : (
								<>
									<div className="flex flex-wrap gap-1.5">
										{skillPaths.map((p) => (
											<button
												key={p}
												type="button"
												onClick={() => setSelectedSkillPath(p)}
												className={cn(
													"rounded-md border px-2 py-1 font-mono text-[11px]",
													selectedSkillPath === p
														? "border-accent bg-accent/15 text-accent"
														: "border-border text-text-muted hover:text-text",
												)}
											>
												{p.replace("/.cadmus/skills/", "")}
											</button>
										))}
									</div>
									{selectedSkillPath ? (
										<MarkdownFileView
											botId={bot.id}
											path={selectedSkillPath}
											title={selectedSkillPath.replace("/.cadmus/skills/", "")}
											onDelete={() => {
												void loadSkills();
											}}
										/>
									) : null}
								</>
							)}
						</div>
					) : tab === "harvest" ? (
						<HarvestView botId={bot.id} />
					) : tab === "config" ? (
						<ConfigPanel
							bot={bot}
							noteCount={notes.length}
							notesPhase="ready"
							onRetryNotes={() => {}}
							onOpenTools={() => {
								onClose();
								void navigate({ to: "/envs" });
							}}
							onOpenHarvest={() => setTab("harvest")}
							onChanged={refreshDirectory}
							onDeleted={() => {
								onClose();
								void refreshDirectory().then(() => navigate({ to: "/bots" }));
							}}
						/>
					) : (
						<RawTranscript entries={entries} />
					)}
				</div>
			</aside>

			<AddEntityDialog
				open={addSkillOpen}
				onClose={() => setAddSkillOpen(false)}
				title={`New skill for ${bot.name}`}
				description="Saved under /.cadmus/skills/<slug>/SKILL.md"
			>
				<form onSubmit={(e) => void handleCreateSkill(e)} className="space-y-3">
					{newSkillError ? (
						<p role="alert" className="text-xs text-destructive">
							{newSkillError}
						</p>
					) : null}
					<label className="block space-y-1">
						<span className="text-xs font-medium text-text-muted">Slug</span>
						<input
							aria-label="Skill slug"
							required
							value={newSkillSlug}
							onChange={(e) => setNewSkillSlug(e.target.value)}
							placeholder="e.g. code-review"
							className="min-h-tap w-full rounded-lg border border-border bg-bg px-3 font-mono text-sm text-text outline-none focus:border-accent"
						/>
					</label>
					<label className="block space-y-1">
						<span className="text-xs font-medium text-text-muted">
							SKILL.md Markdown
						</span>
						<textarea
							aria-label="Skill content"
							rows={6}
							value={newSkillBody}
							onChange={(e) => setNewSkillBody(e.target.value)}
							className="w-full rounded-lg border border-border bg-bg p-3 font-mono text-xs text-text outline-none focus:border-accent"
						/>
					</label>
					<div className="flex justify-end gap-2">
						<button
							type="button"
							onClick={() => setAddSkillOpen(false)}
							className="min-h-tap rounded-lg border border-border px-3 text-xs text-text-muted"
						>
							Cancel
						</button>
						<button
							type="submit"
							disabled={newSkillBusy || !newSkillSlug.trim()}
							className="min-h-tap rounded-lg bg-accent px-4 text-xs font-semibold text-on-accent disabled:opacity-50"
						>
							{newSkillBusy ? "Saving…" : "Save skill"}
						</button>
					</div>
				</form>
			</AddEntityDialog>
		</div>
	);
}
