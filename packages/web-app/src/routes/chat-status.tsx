import { useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { BotPill } from "@/components/BotChip";
import { ChatStatusView } from "@/components/ChatStatusView";
import { SkeletonBlock } from "@/components/Skeleton";
import { useCadmus } from "@/context/CadmusContext";

export function ChatStatusPage() {
	const { chatKey } = useParams({ from: "/chat/$chatKey/status" });
	const { chats, bots, chatStates, refreshChatStatus } = useCadmus();
	const chat = chats.find((entry) => entry.key === chatKey);
	const live = chatStates[chatKey];
	const bot = bots.find((entry) => entry.id === chat?.botId);

	const [loading, setLoading] = useState(!live?.status);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			await refreshChatStatus(chatKey);
			if (!cancelled) {
				setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [chatKey, refreshChatStatus]);

	const currentStatus = live?.status;
	const busy = Boolean(live?.busy);

	return (
		<AppShell
			title="Bot status"
			backTo={`/chat/${chatKey}`}
			subtitle={bot ? <BotPill bot={bot} /> : undefined}
		>
			<div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
				{loading && !currentStatus ? (
					<SkeletonBlock label="Loading status…" />
				) : (
					<ChatStatusView
						status={currentStatus}
						busy={busy}
						model={bot?.model}
					/>
				)}
			</div>
		</AppShell>
	);
}
