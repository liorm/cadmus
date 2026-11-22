import type {
	ChatRecord,
	FileListItem,
	HarvestNote,
	ScheduleRecord,
} from "@cadmus/contract/types";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { AppShell } from "@/components/AppShell";
import { BotBadge } from "@/components/BotBadge";
import { ConfigPanel } from "@/components/ConfigPanel";
import { MarkdownFileView } from "@/components/MarkdownFileView";
import { ScheduleList } from "@/components/ScheduleList";
import { SegmentedControl } from "@/components/SegmentedControl";
import { LoadGate } from "@/components/Skeleton";
import { useCadmus } from "@/context/CadmusContext";
import { useScopedResource } from "@/hooks/useScopedResource";
import type { BotTab } from "@/lib/profile-tabs";

const TABS: Array<{ value: BotTab; label: string }> = [
	{ value: "schedules", label: "Schedules" },
	{ value: "memory", label: "Memory" },
	{ value: "skills", label: "Skills" },
	{ value: "soul", label: "Soul" },
	{ value: "config", label: "Config" },
];

export function ProfilePage({ botId, tab }: { botId: string; tab: BotTab }) {
	const navigate = useNavigate();
	const { client, bots, refreshDirectory } = useCadmus();
	const bot = bots.find((entry) => entry.id === botId);
	const scheduleLoad = useScopedResource(`${botId}:schedules`, async () => {
		const res = await client.callRpc<{ schedules?: ScheduleRecord[] }>(
			"schedule.list",
			{ botId },
		);
		if (!res.ok)
			throw new Error(res.error?.message ?? "Could not load schedules");
		const chats = await client.callRpc<{ chats?: ChatRecord[] }>("chat.list", {
			botId,
			kinds: ["scheduled"],
		});
		if (!chats.ok)
			throw new Error(chats.error?.message ?? "Could not load schedules");
		return {
			schedules: res.result?.schedules ?? [],
			scheduledChats: chats.result?.chats ?? [],
		};
	});
	const fileLoad = useScopedResource(`${botId}:files`, async () => {
		const res = await client.callRpc<{ files?: FileListItem[] }>("file.list", {
			botId,
		});
		if (!res.ok) throw new Error(res.error?.message ?? "Could not load files");
		return res.result?.files ?? [];
	});
	const noteLoad = useScopedResource(`${botId}:notes`, async () => {
		const listed = await client.callRpc<{ chats?: ChatRecord[] }>("chat.list", {
			botId,
			kinds: ["direct", "scheduled"],
		});
		if (!listed.ok)
			throw new Error(listed.error?.message ?? "Could not load notes");
		const details = await Promise.all(
			(listed.result?.chats ?? []).map((chat) =>
				client.callRpc<{ notes?: HarvestNote[] }>("chat.get", {
					chatKey: chat.key,
				}),
			),
		);
		return details.reduce(
			(sum, detail) => sum + (detail.result?.notes?.length ?? 0),
			0,
		);
	});
	const schedules = scheduleLoad.data?.schedules ?? [];
	const scheduledChats = scheduleLoad.data?.scheduledChats ?? [];
	const files = fileLoad.data ?? [];
	const noteCount = noteLoad.data ?? 0;

	useEffect(() => {
		document
			.getElementById(`profile-tab-${tab}`)
			?.scrollIntoView({ inline: "end", block: "nearest" });
	}, [tab]);

	function openTab(next: string) {
		void navigate({
			to: "/bot/$botId/$tab",
			params: { botId, tab: next },
		});
	}

	const skills = files.filter(
		(file) => file.kind === "skill" || file.path.startsWith("/.cadmus/skills/"),
	);

	return (
		<AppShell
			title={bot?.name ?? botId}
			backTo="/"
			titleNode={
				<h1 className="flex min-w-0 items-center gap-2 text-[length:var(--fs-lg)] font-semibold">
					{bot ? (
						<BotBadge bot={bot} className="size-8 min-h-0 min-w-0" />
					) : null}
					<span className="truncate">{bot?.name ?? botId}</span>
				</h1>
			}
		>
			<div className="border-b border-border px-2 py-2">
				<SegmentedControl
					scroll
					ariaLabel="Bot profile tabs"
					value={tab}
					onValueChange={openTab}
					options={TABS.map((item) => ({
						...item,
						id: `profile-tab-${item.value}`,
					}))}
				/>
			</div>
			{tab === "schedules" ? (
				<ScheduleList
					phase={scheduleLoad.phase}
					error={scheduleLoad.error}
					onRetry={scheduleLoad.retry}
					schedules={schedules}
					timeZone={bot?.timezone ?? "UTC"}
					scheduledChats={scheduledChats}
					onOpen={(id) =>
						void navigate({
							to: "/bot/$botId/schedule/$id",
							params: { botId, id },
						})
					}
					onCreate={() =>
						void navigate({
							to: "/bot/$botId/schedule/$id",
							params: { botId, id: "new" },
						})
					}
					onOpenChat={(chatKey) =>
						void navigate({
							to: "/chat/$chatKey",
							params: { chatKey },
							search: { view: "chat" },
						})
					}
					onToggle={(schedule, enabled) => {
						void client
							.callRpc("schedule.update", { id: schedule.id, enabled })
							.then(() => scheduleLoad.retry());
					}}
				/>
			) : null}
			{tab === "memory" ? (
				<MarkdownFileView
					botId={botId}
					path="/.cadmus/MEMORY.md"
					title="MEMORY.md"
				/>
			) : null}
			{tab === "soul" ? (
				<MarkdownFileView
					botId={botId}
					path="/.cadmus/SOUL.md"
					title="SOUL.md"
				/>
			) : null}
			{tab === "skills" ? (
				<div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
					<LoadGate
						phase={fileLoad.phase}
						error={fileLoad.error}
						onRetry={fileLoad.retry}
						label="Loading skills"
					>
						<div className="overflow-hidden rounded-md border border-border bg-surface">
							{skills.length === 0 ? (
								<p className="px-3 py-4 text-[length:var(--fs-sm)] text-text-muted">
									No skills yet.
								</p>
							) : (
								skills.map((file) => {
									const title =
										file.slug ??
										(file.path
											.replace(/^\/\.cadmus\/skills\//, "")
											.replace(/\/SKILL\.md$/i, "") ||
											file.path);
									return (
										<div
											key={file.path}
											className="flex min-h-tap items-center gap-2 border-b border-border px-3 last:border-b-0"
										>
											<button
												type="button"
												className="min-w-0 flex-1 py-2 text-left"
												onClick={() =>
													void navigate({
														to: "/bot/$botId/doc",
														params: { botId },
														search: { path: file.path },
													})
												}
											>
												<div className="truncate font-semibold">{title}</div>
												{file.description ? (
													<div className="truncate text-[length:var(--fs-sm)] text-text-muted">
														{file.description}
													</div>
												) : null}
												<div className="text-[length:var(--fs-sm)] text-text-muted">
													{file.size} bytes
												</div>
											</button>
											<button
												type="button"
												aria-label={`Delete ${title}`}
												className="min-h-tap min-w-tap text-status-failed"
												onClick={() => {
													void client
														.callRpc("file.delete", { botId, path: file.path })
														.then(() => fileLoad.retry());
												}}
											>
												Delete
											</button>
										</div>
									);
								})
							)}
						</div>
					</LoadGate>
				</div>
			) : null}
			{tab === "config" && bot ? (
				<ConfigPanel
					bot={bot}
					noteCount={noteCount}
					notesPhase={noteLoad.phase}
					onRetryNotes={noteLoad.retry}
					onOpenTools={() =>
						void navigate({ to: "/bot/$botId/tools", params: { botId } })
					}
					onOpenHarvest={() =>
						void navigate({ to: "/bot/$botId/harvest", params: { botId } })
					}
					onChanged={refreshDirectory}
					onDeleted={() => {
						void refreshDirectory().then(() => navigate({ to: "/" }));
					}}
				/>
			) : null}
		</AppShell>
	);
}
