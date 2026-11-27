import type {
	BotRecord,
	ModelInfo,
	ThinkingLevel,
} from "@cadmus/contract/types";
import { Link, useNavigate } from "@tanstack/react-router";
import {
	FolderKanban,
	MessageSquare,
	Plus,
	Search,
	Settings2,
	Sparkles,
	Trash2,
} from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { BotBadge } from "@/components/BotBadge";
import { ColorSwatches } from "@/components/ColorSwatches";
import { AddEntityDialog } from "@/components/chrome/AddEntityDialog";
import { GroupChatViewerSheet } from "@/components/GroupChatViewerSheet";
import { ModelSelect } from "@/components/ModelSelect";
import { SegmentedControl } from "@/components/SegmentedControl";
import { StatusShape } from "@/components/StatusShape";
import { UnreadDot } from "@/components/UnreadDot";
import { useCadmus } from "@/context/CadmusContext";
import {
	type BotPaletteSlot,
	botColorVar,
	botInitials,
	derivedBotColor,
} from "@/lib/bot-color";
import { formatRelative } from "@/lib/format-time";
import type { GroupChatMessage } from "@/lib/group-chat-data";
import { modelListRef } from "@/lib/model-ref";
import {
	clampThinkingForModel,
	findModelByRef,
	getThinkingOptionsForModel,
} from "@/lib/thinking-levels";
import { cn } from "@/lib/utils";

function slugifyFamily(input: string): string {
	return input
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
}

export function BotsSidebarPanel({
	activeBotId,
	onSelectBot,
}: {
	activeBotId?: string;
	onSelectBot?: (botId: string) => void;
}) {
	const navigate = useNavigate();
	const {
		client,
		bots,
		chats,
		families,
		familyId,
		switchFamily,
		createFamily,
		updateFamily,
		deleteFamily,
		chatStates,
		compactingChats,
		lastSeen,
		directoryReady,
		directoryError,
		refreshDirectory,
		setLastBotId,
	} = useCadmus();

	const filterId = useId();
	const [filter, setFilter] = useState("");
	const [addBotOpen, setAddBotOpen] = useState(false);
	const [addGroupOpen, setAddGroupOpen] = useState(false);
	const [manageGroupOpen, setManageGroupOpen] = useState(false);

	// Group create state
	const [groupName, setGroupName] = useState("");
	const [groupBusy, setGroupBusy] = useState(false);
	const [groupError, setGroupError] = useState<string | null>(null);

	// Group edit state
	const currentFamily = families.find((f) => f.familyId === familyId);
	const [editFamilyName, setEditFamilyName] = useState("");
	const [editFamilyError, setEditFamilyError] = useState<string | null>(null);
	const [editFamilyBusy, setEditFamilyBusy] = useState(false);

	// Bot create state
	const [botName, setBotName] = useState("");
	const [botModel, setBotModel] = useState("");
	const [botThinking, setBotThinking] = useState<ThinkingLevel>("off");
	const [botSoul, setBotSoul] = useState("");
	const [botSlot, setBotSlot] = useState<BotPaletteSlot | null>(null);
	const [models, setModels] = useState<ModelInfo[]>([]);
	const [botBusy, setBotBusy] = useState(false);
	const [botError, setBotError] = useState<string | null>(null);

	// Group chat viewer state
	const [viewerChat, setViewerChat] = useState<{
		open: boolean;
		topic?: string;
		status?: string;
		members?: string[];
		transcript?: GroupChatMessage[];
	}>({ open: false });

	useEffect(() => {
		if (!addBotOpen) return;
		let cancelled = false;
		void client
			.callRpc<{ models?: ModelInfo[] }>("account.models.list")
			.then((res) => {
				if (cancelled || !res.ok) return;
				const listed = res.result?.models ?? [];
				setModels(listed);
				const firstEnabled =
					listed.find(
						(m) =>
							m.authenticated && (m.tier === "frontier" || m.tier === "fast"),
					) ??
					listed.find((m) => m.authenticated) ??
					listed[0];
				if (firstEnabled && !botModel) {
					setBotModel(modelListRef(firstEnabled));
				}
			});
		return () => {
			cancelled = true;
		};
	}, [addBotOpen, botModel, client]);

	const primaryChatMap = useMemo(() => {
		const map = new Map<string, (typeof chats)[number]>();
		for (const bot of bots) {
			const chat =
				chats.find((c) => c.key === bot.primaryChatKey) ??
				chats.find((c) => c.botId === bot.id && c.kind === "direct");
			if (chat) map.set(bot.id, chat);
		}
		return map;
	}, [bots, chats]);

	const sortedBots = useMemo(() => {
		const q = filter.trim().toLowerCase();
		return [...bots]
			.filter((bot) => !q || bot.name.toLowerCase().includes(q))
			.sort((a, b) => {
				const ca = primaryChatMap.get(a.id);
				const cb = primaryChatMap.get(b.id);
				const ta =
					chatStates[a.primaryChatKey]?.lastBotAt ?? ca?.createdAt ?? 0;
				const tb =
					chatStates[b.primaryChatKey]?.lastBotAt ?? cb?.createdAt ?? 0;
				if (tb !== ta) return tb - ta;
				return a.name.localeCompare(b.name);
			});
	}, [bots, chatStates, filter, primaryChatMap]);

	const groupChats = useMemo(
		() =>
			chats
				.filter((c) => c.kind === "group")
				.sort((a, b) => b.createdAt - a.createdAt),
		[chats],
	);

	async function handleCreateBot(e: React.FormEvent) {
		e.preventDefault();
		const trimmed = botName.trim();
		if (!trimmed || botBusy) return;
		setBotBusy(true);
		setBotError(null);
		const slot = botSlot ?? derivedBotColor(trimmed);
		const res = await client.callRpc<{ bot?: BotRecord }>("bot.create", {
			name: trimmed,
			...(botModel ? { model: botModel } : {}),
			thinking: botThinking,
			...(botSoul.trim() ? { soul: botSoul.trim() } : {}),
			metadata: { color: `bot-${slot}` },
		});
		setBotBusy(false);
		if (!res.ok || !res.result?.bot) {
			setBotError(res.error?.message ?? "Could not create bot.");
			return;
		}
		const created = res.result.bot;
		setBotName("");
		setBotThinking("off");
		setBotSoul("");
		setBotSlot(null);
		setAddBotOpen(false);
		setLastBotId(created.id);
		await refreshDirectory();
		onSelectBot?.(created.id);
		await navigate({ to: "/bot/$botId", params: { botId: created.id } });
	}

	async function handleCreateGroup(e: React.FormEvent) {
		e.preventDefault();
		const trimmed = groupName.trim();
		const slug = slugifyFamily(trimmed);
		if (!trimmed || !slug || groupBusy) return;
		setGroupBusy(true);
		setGroupError(null);
		const created = await createFamily({
			familyId: slug,
			name: trimmed,
		});
		setGroupBusy(false);
		if (!created) {
			setGroupError("Could not create bot group. Try another name.");
			return;
		}
		setGroupName("");
		setAddGroupOpen(false);
	}

	async function handleOpenGroupChat(chatKey: string, title?: string) {
		const res = await client.callRpc<{
			chat?: { title?: string; closed?: boolean };
			messages?: Array<{
				role: string;
				text?: string;
				name?: string;
				timestamp?: number;
			}>;
		}>("chat.get", { chatKey, limit: 100 });
		const msgs = res.ok ? (res.result?.messages ?? []) : [];
		const transcript: GroupChatMessage[] = msgs
			.filter((m) => m.text?.trim())
			.map((m) => ({
				fromBotId: m.name || m.role,
				text: m.text ?? "",
				at: m.timestamp ?? Date.now(),
			}));
		const members = Array.from(
			new Set(transcript.map((item) => item.fromBotId).filter(Boolean)),
		);
		setViewerChat({
			open: true,
			topic: res.result?.chat?.title || title || "Group collaboration",
			status: res.result?.chat?.closed ? "ended" : "running",
			members,
			transcript,
		});
	}

	const slotPreview = botSlot ?? derivedBotColor(botName);
	const selectedModel = findModelByRef(models, botModel);
	const thinkingOptions = getThinkingOptionsForModel(
		selectedModel,
		botThinking,
	);

	function handleBotModelChange(nextRef: string) {
		setBotModel(nextRef);
		const nextModel = findModelByRef(models, nextRef);
		setBotThinking((prev) => clampThinkingForModel(prev, nextModel));
	}

	const groupPills =
		families.length > 0
			? families.map((f) => ({ id: f.familyId, name: f.name || f.familyId }))
			: [
					{
						id: familyId,
						name: familyId === "default" ? "Default" : familyId,
					},
				];

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{/* Bot Groups (Families) strip */}
			<div className="border-b border-border px-3 py-2">
				<div className="flex items-center justify-between gap-2">
					<span className="inline-flex min-w-0 items-center gap-1.5 text-xs font-medium text-text-muted">
						<FolderKanban className="h-3.5 w-3.5 shrink-0" />
						<span className="truncate">
							{groupPills.length === 1
								? groupPills[0]?.name
								: "Bot groups"}
						</span>
					</span>
					<div className="flex shrink-0 items-center gap-1">
						{currentFamily ? (
							<button
								type="button"
								aria-label="Manage current bot group"
								onClick={() => {
									setEditFamilyName(currentFamily.name);
									setEditFamilyError(null);
									setManageGroupOpen(true);
								}}
								className="rounded p-1 text-text-muted hover:bg-surface-raised hover:text-text"
							>
								<Settings2 className="h-3.5 w-3.5" />
							</button>
						) : null}
						<button
							type="button"
							onClick={() => {
								setGroupError(null);
								setAddGroupOpen(true);
							}}
							className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-text-muted hover:bg-surface-raised hover:text-text"
						>
							<Plus className="h-3 w-3" />
							Group
						</button>
					</div>
				</div>
				{groupPills.length > 1 ? (
					<div className="mt-1.5 flex gap-1.5 overflow-x-auto pb-0.5">
						{groupPills.map((fam) => {
							const active = fam.id === familyId;
							return (
								<button
									key={fam.id}
									type="button"
									onClick={() => void switchFamily(fam.id)}
									className={cn(
										"shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium transition",
										active
											? "border-accent bg-accent/15 text-accent"
											: "border-border bg-bg/50 text-text-muted hover:text-text",
									)}
								>
									{fam.name}
								</button>
							);
						})}
					</div>
				) : null}
			</div>

			{/* Search + New Bot */}
			<div className="flex items-center gap-2 border-b border-border px-3 py-2">
				<div className="flex min-h-tap min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-bg/60 px-2.5 md:min-h-0 md:h-8">
					<Search className="h-3.5 w-3.5 shrink-0 text-text-muted" />
					<label htmlFor={filterId} className="sr-only">
						Filter bots
					</label>
					<input
						id={filterId}
						placeholder="Filter bots"
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
						className="min-w-0 flex-1 bg-transparent text-xs text-text outline-none placeholder:text-text-muted"
					/>
				</div>
				<button
					type="button"
					onClick={() => {
						setBotError(null);
						setAddBotOpen(true);
					}}
					aria-label="New bot"
					className="inline-flex min-h-tap shrink-0 items-center gap-1 rounded-lg bg-accent px-2.5 text-xs font-semibold text-on-accent hover:opacity-90 md:min-h-0 md:h-8"
				>
					<Plus className="h-3.5 w-3.5" />
					<span>Bot</span>
				</button>
			</div>

			{/* Bots contact list */}
			<div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
				{directoryError ? (
					<div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
						<p>{directoryError}</p>
						<button
							type="button"
							onClick={() => void refreshDirectory()}
							className="mt-2 underline"
						>
							Retry
						</button>
					</div>
				) : !directoryReady ? (
					<p className="px-2 py-4 text-xs text-text-muted">Loading bots…</p>
				) : sortedBots.length === 0 ? (
					<div className="px-2 py-6 text-center">
						<p className="text-xs text-text-muted">
							{bots.length === 0
								? "No bots in this group yet."
								: "No bots match that filter."}
						</p>
						{bots.length === 0 ? (
							<button
								type="button"
								onClick={() => setAddBotOpen(true)}
								className="mt-3 inline-flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-on-accent"
							>
								<Plus className="h-3.5 w-3.5" />
								Create bot
							</button>
						) : null}
					</div>
				) : (
					<ul className="space-y-1">
						{sortedBots.map((bot) => {
							const chatKey = bot.primaryChatKey;
							const chat = primaryChatMap.get(bot.id);
							const live = chatStates[chatKey];
							const compacting = Boolean(compactingChats[chatKey]);
							const selected = activeBotId === bot.id;
							const lastActivity = live?.lastBotAt ?? chat?.createdAt;
							const unread = Boolean(
								chat &&
									(lastActivity ?? 0) > (lastSeen[chatKey] ?? 0) &&
									!selected,
							);
							const status = live?.busy
								? ("running" as const)
								: live?.failedReason
									? ("failed" as const)
									: ("idle" as const);
							const preview =
								live?.streamText?.trim() ||
								live?.lastBotText?.trim() ||
								live?.lastUserText?.trim() ||
								chat?.title ||
								bot.model;

							return (
								<li key={bot.id}>
									<Link
										to="/bot/$botId"
										params={{ botId: bot.id }}
										onClick={() => {
											setLastBotId(bot.id);
											onSelectBot?.(bot.id);
										}}
										className={cn(
											"flex min-h-tap items-center gap-2.5 rounded-xl border px-2.5 py-2 transition",
											selected
												? "border-accent/40 bg-accent/10"
												: "border-transparent hover:bg-surface-raised",
										)}
									>
										<BotBadge bot={bot} className="size-9 shrink-0" />
										<div className="min-w-0 flex-1">
											<div className="flex items-center justify-between gap-1.5">
												<span className="truncate text-xs font-semibold text-text">
													{bot.name}
												</span>
												<span className="shrink-0 tabular-nums text-[10px] text-text-muted">
													{lastActivity ? formatRelative(lastActivity) : ""}
												</span>
											</div>
											<div className="mt-0.5 flex items-center gap-1.5">
												{status !== "idle" ? (
													<StatusShape status={status} />
												) : null}
												{compacting ? (
													<Sparkles
														aria-label="Compacting context"
														className="h-3 w-3 shrink-0 text-accent"
													/>
												) : null}
												<span className="min-w-0 flex-1 truncate text-[11px] text-text-muted">
													{preview}
												</span>
												{unread ? <UnreadDot /> : null}
											</div>
										</div>
									</Link>
								</li>
							);
						})}
					</ul>
				)}

				{groupChats.length > 0 ? (
					<div className="mt-4 border-t border-border pt-3">
						<div className="mb-1.5 px-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
							Group Collaborations ({groupChats.length})
						</div>
						<ul className="space-y-1">
							{groupChats.slice(0, 6).map((gc) => (
								<li key={gc.key}>
									<button
										type="button"
										onClick={() => void handleOpenGroupChat(gc.key, gc.title)}
										className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-text-muted hover:bg-surface-raised hover:text-text"
									>
										<MessageSquare className="h-3.5 w-3.5 shrink-0 text-accent" />
										<span className="min-w-0 flex-1 truncate">
											{gc.title || gc.key}
										</span>
										<span className="shrink-0 text-[10px] opacity-75">
											{gc.closed ? "ended" : "active"}
										</span>
									</button>
								</li>
							))}
						</ul>
					</div>
				) : null}
			</div>

			{/* Create Bot Dialog */}
			<AddEntityDialog
				open={addBotOpen}
				onClose={() => setAddBotOpen(false)}
				title="New bot"
				description="Bots have a single continuous conversation stream and dedicated /.cadmus/ memory."
			>
				<form onSubmit={(e) => void handleCreateBot(e)} className="space-y-4">
					{botError ? (
						<p role="alert" className="text-xs text-destructive">
							{botError}
						</p>
					) : null}
					<div className="flex items-center gap-3">
						<span
							aria-hidden="true"
							className="inline-flex size-12 items-center justify-center rounded-2xl text-sm font-semibold text-on-accent"
							style={{ background: botColorVar(slotPreview) }}
						>
							{botInitials(botName)}
						</span>
						<div className="min-w-0">
							<div className="truncate text-sm font-semibold text-text">
								{botName.trim() || "New bot"}
							</div>
							<div className="text-xs text-text-muted">
								Stream key updates automatically after creation
							</div>
						</div>
					</div>
					<label className="block space-y-1">
						<span className="text-xs font-medium text-text-muted">Name</span>
						<input
							aria-label="Bot name"
							required
							value={botName}
							onChange={(e) => setBotName(e.target.value)}
							placeholder="e.g. Research Assistant"
							className="min-h-tap w-full rounded-lg border border-border bg-bg px-3 text-sm text-text outline-none focus:border-accent"
						/>
					</label>
					{models.length > 0 ? (
						<>
							<div className="space-y-1">
								<span className="text-xs font-medium text-text-muted">
									Model
								</span>
								<ModelSelect
									ariaLabel="Bot model"
									models={models}
									value={botModel}
									onChange={handleBotModelChange}
								/>
							</div>
							<div className="space-y-1">
								<span className="text-xs font-medium text-text-muted">
									Thinking level
								</span>
								{thinkingOptions.length > 0 ? (
									<SegmentedControl
										ariaLabel="Thinking level"
										scroll
										value={botThinking}
										onValueChange={(next) =>
											setBotThinking(next as ThinkingLevel)
										}
										options={thinkingOptions}
										className="border border-border bg-bg"
									/>
								) : (
									<p className="rounded-lg border border-border bg-bg px-3 py-2 text-xs text-text-muted">
										Selected model does not support thinking levels.
									</p>
								)}
							</div>
						</>
					) : null}
					<div className="space-y-1.5">
						<span className="text-xs font-medium text-text-muted">Colour</span>
						<ColorSwatches
							value={slotPreview}
							onChange={(next) => setBotSlot(next)}
						/>
					</div>
					<label className="block space-y-1">
						<span className="text-xs font-medium text-text-muted">
							SOUL.md prompt (optional)
						</span>
						<textarea
							aria-label="Bot soul"
							rows={3}
							value={botSoul}
							onChange={(e) => setBotSoul(e.target.value)}
							placeholder="Describe this bot's specialty and working style…"
							className="w-full rounded-lg border border-border bg-bg p-3 text-sm text-text outline-none focus:border-accent"
						/>
					</label>
					<div className="flex justify-end gap-2 pt-2">
						<button
							type="button"
							onClick={() => setAddBotOpen(false)}
							className="min-h-tap rounded-lg border border-border px-4 text-xs font-medium text-text-muted hover:text-text"
						>
							Cancel
						</button>
						<button
							type="submit"
							disabled={botBusy || !botName.trim()}
							className="min-h-tap rounded-lg bg-accent px-4 text-xs font-semibold text-on-accent hover:opacity-90 disabled:opacity-50"
						>
							{botBusy ? "Creating…" : "Create bot"}
						</button>
					</div>
				</form>
			</AddEntityDialog>

			{/* Create Bot Group Dialog */}
			<AddEntityDialog
				open={addGroupOpen}
				onClose={() => setAddGroupOpen(false)}
				title="New Bot Group"
				description="Organize bots into a shared collaboration group (family)."
			>
				<form onSubmit={(e) => void handleCreateGroup(e)} className="space-y-4">
					{groupError ? (
						<p role="alert" className="text-xs text-destructive">
							{groupError}
						</p>
					) : null}
					<label className="block space-y-1">
						<span className="text-xs font-medium text-text-muted">
							Group name
						</span>
						<input
							aria-label="Group name"
							required
							value={groupName}
							onChange={(e) => setGroupName(e.target.value)}
							placeholder="e.g. Engineering Ops"
							className="min-h-tap w-full rounded-lg border border-border bg-bg px-3 text-sm text-text outline-none focus:border-accent"
						/>
						{groupName.trim() ? (
							<span className="block text-[11px] text-text-muted">
								ID:{" "}
								<span className="font-mono">{slugifyFamily(groupName)}</span>
							</span>
						) : null}
					</label>
					<div className="flex justify-end gap-2">
						<button
							type="button"
							onClick={() => setAddGroupOpen(false)}
							className="min-h-tap rounded-lg border border-border px-4 text-xs font-medium text-text-muted hover:text-text"
						>
							Cancel
						</button>
						<button
							type="submit"
							disabled={groupBusy || !slugifyFamily(groupName)}
							className="min-h-tap rounded-lg bg-accent px-4 text-xs font-semibold text-on-accent hover:opacity-90 disabled:opacity-50"
						>
							{groupBusy ? "Creating…" : "Create group"}
						</button>
					</div>
				</form>
			</AddEntityDialog>

			{/* Manage Current Bot Group Dialog */}
			<AddEntityDialog
				open={manageGroupOpen}
				onClose={() => setManageGroupOpen(false)}
				title={`Manage group: ${currentFamily?.name ?? familyId}`}
			>
				<div className="space-y-4">
					{editFamilyError ? (
						<p role="alert" className="text-xs text-destructive">
							{editFamilyError}
						</p>
					) : null}
					<form
						onSubmit={(e) => {
							e.preventDefault();
							if (!currentFamily || !editFamilyName.trim()) return;
							setEditFamilyBusy(true);
							setEditFamilyError(null);
							void updateFamily(currentFamily.familyId, {
								name: editFamilyName.trim(),
							})
								.then((ok) => {
									if (!ok) setEditFamilyError("Could not rename group.");
									else setManageGroupOpen(false);
								})
								.finally(() => setEditFamilyBusy(false));
						}}
						className="space-y-3"
					>
						<label className="block space-y-1">
							<span className="text-xs font-medium text-text-muted">
								Display name
							</span>
							<input
								aria-label="Display name"
								value={editFamilyName}
								onChange={(e) => setEditFamilyName(e.target.value)}
								className="min-h-tap w-full rounded-lg border border-border bg-bg px-3 text-sm text-text outline-none focus:border-accent"
							/>
						</label>
						<button
							type="submit"
							disabled={editFamilyBusy || !editFamilyName.trim()}
							className="min-h-tap rounded-lg bg-accent px-4 text-xs font-semibold text-on-accent disabled:opacity-50"
						>
							Save name
						</button>
					</form>
					{familyId !== "default" ? (
						<div className="border-t border-border pt-3">
							<button
								type="button"
								disabled={editFamilyBusy}
								onClick={() => {
									setEditFamilyBusy(true);
									void deleteFamily(familyId)
										.then((ok) => {
											if (!ok) {
												setEditFamilyError(
													"Group could not be deleted (must have no active conflicts).",
												);
											} else {
												setManageGroupOpen(false);
											}
										})
										.finally(() => setEditFamilyBusy(false));
								}}
								className="inline-flex min-h-tap items-center gap-1.5 rounded-lg border border-destructive/40 px-3 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
							>
								<Trash2 className="h-3.5 w-3.5" />
								Delete bot group
							</button>
						</div>
					) : null}
				</div>
			</AddEntityDialog>

			<GroupChatViewerSheet
				open={viewerChat.open}
				onOpenChange={(open) => setViewerChat((prev) => ({ ...prev, open }))}
				topic={viewerChat.topic}
				status={viewerChat.status}
				members={viewerChat.members}
				transcript={viewerChat.transcript}
				bots={bots}
			/>
		</div>
	);
}
