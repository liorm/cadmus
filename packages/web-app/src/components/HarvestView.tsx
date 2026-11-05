import type {
	ChatRecord,
	HarvestFileDiff,
	HarvestNote,
	ServerEvent,
} from "@cadmus/contract/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { LoadGate } from "@/components/Skeleton";
import { Toggle } from "@/components/Toggle";
import { useCadmus } from "@/context/CadmusContext";
import { useScopedResource } from "@/hooks/useScopedResource";
import { diffSummary } from "@/lib/diff-stat";
import { chatTitle, formatRelative } from "@/lib/format-time";

function noteKey(note: HarvestNote): string {
	return `${note.chatKey}:${note.at}:${note.when}`;
}

function DiffBlock({ file }: { file: HarvestFileDiff }) {
	return (
		<pre className="overflow-x-auto rounded-md border border-border bg-bg p-2 font-mono text-[length:var(--fs-xs)]">
			<div className="mb-1 text-text-muted">{file.path}</div>
			{file.diff.split("\n").map((line, index) => {
				const added = line.startsWith("+") && !line.startsWith("+++");
				const removed = line.startsWith("-") && !line.startsWith("---");
				const key = `${file.path}:${line}:${index}`;
				return (
					<div
						key={key}
						className={
							added
								? "text-status-done"
								: removed
									? "text-status-failed"
									: "text-text-muted"
						}
					>
						{line || " "}
					</div>
				);
			})}
		</pre>
	);
}

export function HarvestView({ botId }: { botId: string }) {
	const { client, subscribeEvents } = useCadmus();
	const loaded = useScopedResource(botId, async () => {
		const listed = await client.callRpc<{ chats?: ChatRecord[] }>("chat.list", {
			botId,
			kinds: ["direct", "scheduled", "group", "group-member"],
		});
		if (!listed.ok)
			throw new Error(listed.error?.message ?? "Could not load harvest");
		const chatList = (listed.result?.chats ?? []).filter(
			(chat) => chat.botId === botId,
		);
		const details = await Promise.all(
			chatList.map((chat) =>
				client.callRpc<{ notes?: HarvestNote[] }>("chat.get", {
					chatKey: chat.key,
				}),
			),
		);
		const merged: HarvestNote[] = [];
		const seen = new Set<string>();
		for (const detail of details) {
			for (const note of detail.result?.notes ?? []) {
				const key = noteKey(note);
				if (seen.has(key)) continue;
				seen.add(key);
				merged.push(note);
			}
		}
		merged.sort((a, b) => b.when - a.when);
		return { chats: chatList, notes: merged };
	});
	const [chatOverride, setChatOverride] = useState<ChatRecord[] | null>(null);
	const [noteOverride, setNoteOverride] = useState<HarvestNote[] | null>(null);
	const chats = chatOverride ?? loaded.data?.chats ?? [];
	const notes = noteOverride ?? loaded.data?.notes ?? [];
	const [openKey, setOpenKey] = useState<string | null>(null);
	const chatKeys = useRef(new Set<string>());

	useEffect(() => {
		chatKeys.current = new Set(chats.map((chat) => chat.key));
	}, [chats]);

	const notesRef = useRef(notes);
	notesRef.current = notes;
	useEffect(() => {
		void loaded.data;
		setChatOverride(null);
		setNoteOverride(null);
	}, [loaded.data]);

	useEffect(() => {
		return subscribeEvents((event: ServerEvent) => {
			if (event.type !== "harvest.note") return;
			const note = event.payload;
			if (chatKeys.current.has(note.chatKey)) {
				setNoteOverride((prev) => {
					const base = prev ?? notesRef.current;
					if (base.some((item) => noteKey(item) === noteKey(note))) return base;
					return [note, ...base].sort((a, b) => b.when - a.when);
				});
				return;
			}
			void client
				.callRpc<{ chat?: ChatRecord }>("chat.get", { chatKey: note.chatKey })
				.then((detail) => {
					if (detail.result?.chat?.botId !== botId) return;
					chatKeys.current.add(note.chatKey);
					loaded.retry();
				})
				.catch(() => undefined);
		});
	}, [botId, client, loaded.retry, subscribeEvents]);

	const groups = useMemo(() => {
		return chats
			.map((chat) => ({
				chat,
				notes: notes
					.filter((note) => note.chatKey === chat.key)
					.sort((a, b) => b.when - a.when),
			}))
			.filter((group) => group.notes.length > 0)
			.sort((a, b) => (b.notes[0]?.when ?? 0) - (a.notes[0]?.when ?? 0));
	}, [chats, notes]);

	async function setHarvest(chat: ChatRecord, harvest: boolean) {
		setChatOverride(
			chats.map((item) =>
				item.key === chat.key ? { ...item, harvest } : item,
			),
		);
		await client.callRpc("chat.update", { chatKey: chat.key, harvest });
	}

	return (
		<div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
			<p className="mb-3 text-[length:var(--fs-sm)] text-text-muted">
				Completed harvest notes, newest first. Updates live.
			</p>
			{loaded.phase !== "ready" ? (
				<LoadGate
					phase={loaded.phase}
					error={loaded.error}
					onRetry={loaded.retry}
					label="Loading harvest"
				>
					{null}
				</LoadGate>
			) : groups.length === 0 ? (
				<p className="text-[length:var(--fs-sm)] text-text-muted">
					No harvest notes yet.
				</p>
			) : (
				groups.map((group) => (
					<section
						key={group.chat.key}
						className="mb-4"
						aria-label={chatTitle(group.chat)}
					>
						<div className="mb-2 flex items-center justify-between gap-2">
							<h2 className="truncate font-semibold">
								{chatTitle(group.chat)}
							</h2>
							<Toggle
								label={
									group.chat.harvest === false ? "Harvest off" : "Harvest on"
								}
								checked={group.chat.harvest !== false}
								onCheckedChange={(on) => void setHarvest(group.chat, on)}
							/>
						</div>
						<div className="overflow-hidden rounded-md border border-border bg-surface">
							{group.notes.map((note) => {
								const key = noteKey(note);
								const open = openKey === key;
								const headline =
									note.files.map((file) => file.path).join(", ") || "No files";
								const summary = note.files
									.map((file) => diffSummary(file.path, file.diff))
									.join(" · ");
								return (
									<div
										key={key}
										className="border-b border-border last:border-b-0"
									>
										<button
											type="button"
											aria-expanded={open}
											className="flex w-full flex-col px-3 py-2 text-left"
											onClick={() => setOpenKey(open ? null : key)}
										>
											<span className="truncate font-semibold">{headline}</span>
											<span className="text-[length:var(--fs-sm)] text-text-muted">
												{formatRelative(note.when)} · {summary}
											</span>
										</button>
										{open ? (
											<div className="flex flex-col gap-2 px-3 pb-3">
												{note.files.map((file) => (
													<DiffBlock key={file.path} file={file} />
												))}
											</div>
										) : null}
									</div>
								);
							})}
						</div>
					</section>
				))
			)}
		</div>
	);
}
