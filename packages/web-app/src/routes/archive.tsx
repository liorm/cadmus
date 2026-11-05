import type { ChatRecord } from "@cadmus/contract/types";
import { Link } from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";
import { BotBadge } from "@/components/BotBadge";
import { LoadGate } from "@/components/Skeleton";
import { useCadmus } from "@/context/CadmusContext";
import { useScopedResource } from "@/hooks/useScopedResource";
import { botColor, botColorVar } from "@/lib/bot-color";
import { chatTitle } from "@/lib/format-time";

function archivedWhen(ts: number): string {
	const date = new Date(ts);
	const now = new Date();
	const sameDay =
		date.getFullYear() === now.getFullYear() &&
		date.getMonth() === now.getMonth() &&
		date.getDate() === now.getDate();
	if (sameDay) return "Archived today";
	return `Archived ${date.toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
	})}`;
}

export function ArchivePage() {
	const { client, bots, familyId } = useCadmus();
	const loaded = useScopedResource(`${familyId}:archive`, async () => {
		const res = await client.callRpc<{ chats?: ChatRecord[] }>("chat.list", {
			kinds: ["direct"],
		});
		if (!res.ok)
			throw new Error(res.error?.message ?? "Could not load archive");
		return (res.result?.chats ?? []).filter((chat) => chat.closed);
	});
	const chats = loaded.data ?? [];

	const groups = bots
		.map((bot) => ({
			bot,
			chats: chats
				.filter((chat) => chat.botId === bot.id)
				.sort((a, b) => b.createdAt - a.createdAt),
		}))
		.filter((group) => group.chats.length > 0);

	return (
		<AppShell title="Archive" backTo="/settings">
			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-4">
				<LoadGate
					phase={loaded.phase}
					error={loaded.error}
					onRetry={loaded.retry}
					label="Loading archive"
				>
					{groups.length === 0 ? (
						<p className="text-[length:var(--fs-sm)] text-text-muted">
							No archived chats.
						</p>
					) : (
						groups.map((group) => {
							const slot = botColor(group.bot);
							return (
								<section key={group.bot.id} aria-label={group.bot.name}>
									<header className="mb-2 flex items-center gap-2 px-1">
										<BotBadge
											bot={group.bot}
											className="size-8 min-h-0 min-w-0"
										/>
										<h2 className="truncate font-semibold">{group.bot.name}</h2>
									</header>
									<div className="flex overflow-hidden rounded-md border border-border bg-surface">
										<div
											aria-hidden="true"
											className="w-1 shrink-0"
											style={{ background: botColorVar(slot) }}
										/>
										<div className="min-w-0 flex-1">
											{group.chats.map((chat) => (
												<Link
													key={chat.key}
													to="/chat/$chatKey"
													params={{ chatKey: chat.key }}
													search={{ view: "chat" }}
													className="flex min-h-tap items-center gap-2 border-b border-border px-3 py-2 last:border-b-0"
												>
													<span className="min-w-0 flex-1">
														<span className="block truncate font-semibold">
															{chatTitle(chat)}
														</span>
														<span className="block text-[length:var(--fs-sm)] text-text-muted">
															{archivedWhen(chat.createdAt)}
														</span>
													</span>
													<span aria-hidden="true" className="text-text-muted">
														›
													</span>
												</Link>
											))}
										</div>
									</div>
								</section>
							);
						})
					)}
				</LoadGate>
			</div>
		</AppShell>
	);
}
