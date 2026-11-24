import { Plus, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { BotBadge } from "@/components/BotBadge";
import { AddEntityDialog } from "@/components/chrome/AddEntityDialog";
import { MarkdownFileView } from "@/components/MarkdownFileView";
import { LoadGate } from "@/components/Skeleton";
import { useCadmus } from "@/context/CadmusContext";
import { useScopedResource } from "@/hooks/useScopedResource";
import { UserShell } from "@/surfaces/user/UserShell";

interface SkillEntry {
	botId: string;
	botName: string;
	path: string;
}

export function SkillsPage() {
	const { client, bots, familyId } = useCadmus();
	const loaded = useScopedResource(
		`${familyId}:skills:${bots.length}`,
		async () => {
			const results: SkillEntry[] = [];
			await Promise.all(
				bots.map(async (bot) => {
					const res = await client.callRpc<{ files?: Array<{ path: string }> }>(
						"file.list",
						{ botId: bot.id },
					);
					if (!res.ok) return;
					for (const f of res.result?.files ?? []) {
						if (
							f.path.startsWith("/.cadmus/skills/") &&
							f.path.endsWith(".md")
						) {
							results.push({ botId: bot.id, botName: bot.name, path: f.path });
						}
					}
				}),
			);
			return results.sort((a, b) => a.path.localeCompare(b.path));
		},
	);

	const items = loaded.data ?? [];
	const [selected, setSelected] = useState<SkillEntry | null>(null);
	const [addOpen, setAddOpen] = useState(false);
	const [targetBotId, setTargetBotId] = useState("");
	const [slug, setSlug] = useState("");
	const [body, setBody] = useState(
		"---\ndescription: Describe when the bot should use this skill.\n---\n\n# New Skill\n\nDescribe the workflow, constraints, and checks.\n",
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!selected && items[0]) setSelected(items[0]);
	}, [items, selected]);

	async function handleCreateSkill(e: React.FormEvent) {
		e.preventDefault();
		const botId = targetBotId || bots[0]?.id;
		const cleanSlug = slug
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/^-+|-+$/g, "");
		if (!botId || !cleanSlug || busy) return;
		const path = `/.cadmus/skills/${cleanSlug}/SKILL.md`;
		setBusy(true);
		setError(null);
		const res = await client.callRpc("file.write", {
			botId,
			path,
			content: body,
		});
		setBusy(false);
		if (!res.ok) {
			setError(res.error?.message ?? "Could not create skill.");
			return;
		}
		const bot = bots.find((b) => b.id === botId);
		setSlug("");
		setAddOpen(false);
		loaded.retry();
		if (bot) setSelected({ botId: bot.id, botName: bot.name, path });
	}

	return (
		<UserShell activeTab="skills" mobileTitle="Skills">
			<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
				<header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface px-4 py-3 sm:px-6">
					<div className="flex items-center gap-2.5">
						<Sparkles className="h-5 w-5 text-accent" />
						<div>
							<h1 className="text-sm font-semibold text-text">
								Procedural Skills ({" "}
								<code className="font-mono text-xs text-accent">
									/.cadmus/skills/
								</code>{" "}
								)
							</h1>
							<p className="text-xs text-text-muted">
								Browse and edit markdown skills stored across bots in this group
							</p>
						</div>
					</div>
					<button
						type="button"
						disabled={bots.length === 0}
						onClick={() => {
							setTargetBotId(bots[0]?.id ?? "");
							setError(null);
							setAddOpen(true);
						}}
						className="inline-flex min-h-tap items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-semibold text-on-accent hover:opacity-90 disabled:opacity-50"
					>
						<Plus className="h-3.5 w-3.5" />
						New skill
					</button>
				</header>

				<div className="flex min-h-0 flex-1 flex-col md:flex-row">
					<div className="border-b border-border bg-surface/50 p-3 md:w-80 md:shrink-0 md:overflow-y-auto md:border-b-0 md:border-r">
						<LoadGate
							phase={loaded.phase}
							error={loaded.error}
							onRetry={loaded.retry}
							label="Loading skills"
						>
							{items.length === 0 ? (
								<p className="p-2 text-xs text-text-muted">
									No skill files yet across bots in this group.
								</p>
							) : (
								<ul className="space-y-1.5">
									{items.map((item) => {
										const bot = bots.find((b) => b.id === item.botId);
										const active =
											selected?.botId === item.botId &&
											selected?.path === item.path;
										return (
											<li key={`${item.botId}:${item.path}`}>
												<button
													type="button"
													onClick={() => setSelected(item)}
													className={
														active
															? "flex w-full items-center gap-2.5 rounded-xl border border-accent/40 bg-accent/10 px-3 py-2 text-left"
															: "flex w-full items-center gap-2.5 rounded-xl border border-border bg-surface px-3 py-2 text-left hover:bg-surface-raised"
													}
												>
													{bot ? (
														<BotBadge bot={bot} className="size-7 shrink-0" />
													) : null}
													<div className="min-w-0 flex-1">
														<div className="truncate font-mono text-xs font-semibold text-text">
															{item.path.replace("/.cadmus/skills/", "")}
														</div>
														<div className="truncate text-[11px] text-text-muted">
															{item.botName}
														</div>
													</div>
												</button>
											</li>
										);
									})}
								</ul>
							)}
						</LoadGate>
					</div>

					<div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
						{selected ? (
							<div className="mx-auto max-w-3xl">
								<div className="mb-3 flex items-center gap-2 text-xs text-text-muted">
									<span className="font-semibold text-text">
										{selected.botName}
									</span>
									<span>·</span>
									<span className="font-mono">{selected.path}</span>
								</div>
								<MarkdownFileView
									botId={selected.botId}
									path={selected.path}
									title={selected.path.replace("/.cadmus/skills/", "")}
									onDelete={() => {
										setSelected(null);
										loaded.retry();
									}}
								/>
							</div>
						) : (
							<p className="py-12 text-center text-xs text-text-muted">
								Select a skill from the list to inspect or edit it.
							</p>
						)}
					</div>
				</div>
			</div>

			<AddEntityDialog
				open={addOpen}
				onClose={() => setAddOpen(false)}
				title="New Skill"
				description="Writes /.cadmus/skills/<slug>/SKILL.md into the chosen bot."
			>
				<form onSubmit={(e) => void handleCreateSkill(e)} className="space-y-3">
					{error ? (
						<p role="alert" className="text-xs text-destructive">
							{error}
						</p>
					) : null}
					<label className="block space-y-1">
						<span className="text-xs font-medium text-text-muted">Bot</span>
						<select
							aria-label="Bot"
							value={targetBotId || bots[0]?.id || ""}
							onChange={(e) => setTargetBotId(e.target.value)}
							className="min-h-tap w-full rounded-lg border border-border bg-bg px-3 text-sm text-text"
						>
							{bots.map((b) => (
								<option key={b.id} value={b.id}>
									{b.name}
								</option>
							))}
						</select>
					</label>
					<label className="block space-y-1">
						<span className="text-xs font-medium text-text-muted">Slug</span>
						<input
							aria-label="Skill slug"
							required
							value={slug}
							onChange={(e) => setSlug(e.target.value)}
							placeholder="e.g. weekly-summary"
							className="min-h-tap w-full rounded-lg border border-border bg-bg px-3 font-mono text-sm text-text"
						/>
					</label>
					<label className="block space-y-1">
						<span className="text-xs font-medium text-text-muted">Content</span>
						<textarea
							aria-label="Skill markdown"
							rows={6}
							value={body}
							onChange={(e) => setBody(e.target.value)}
							className="w-full rounded-lg border border-border bg-bg p-3 font-mono text-xs text-text"
						/>
					</label>
					<div className="flex justify-end gap-2">
						<button
							type="button"
							onClick={() => setAddOpen(false)}
							className="min-h-tap rounded-lg border border-border px-4 text-xs text-text-muted"
						>
							Cancel
						</button>
						<button
							type="submit"
							disabled={busy || !slug.trim()}
							className="min-h-tap rounded-lg bg-accent px-4 text-xs font-semibold text-on-accent disabled:opacity-50"
						>
							{busy ? "Saving…" : "Create skill"}
						</button>
					</div>
				</form>
			</AddEntityDialog>
		</UserShell>
	);
}
