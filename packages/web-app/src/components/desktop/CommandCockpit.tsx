import { type JSX, useCallback, useEffect, useState } from "react";
import { useCadmus } from "@/context/CadmusContext";
import { CockpitFrame } from "./CockpitFrame";
import { DesktopChatConsole } from "./DesktopChatConsole";
import { FleetDeck } from "./FleetDeck";
import { TelemetryDeck } from "./TelemetryDeck";

type FleetFilter = "all" | "running" | "needs";

function newestNotClosed(
	botId: string,
	chats: ReadonlyArray<{
		key: string;
		botId: string;
		closed?: boolean;
		deleted?: boolean;
		createdAt: number;
	}>,
	chatStates: Record<string, { lastBotAt?: number } | undefined>,
): string | null {
	let bestKey: string | null = null;
	let bestAt = Number.NEGATIVE_INFINITY;
	for (const chat of chats) {
		if (chat.botId !== botId || chat.closed || chat.deleted) continue;
		const at = chatStates[chat.key]?.lastBotAt ?? chat.createdAt;
		if (at < bestAt) continue;
		bestAt = at;
		bestKey = chat.key;
	}
	return bestKey;
}

export function CommandCockpit(): JSX.Element {
	const { bots, chats, chatStates, lastBotId, setLastBotId } = useCadmus();
	const [selectedBotId, setSelectedBotId] = useState(
		() => lastBotId ?? bots[0]?.id ?? "",
	);
	const [selectedChatKey, setSelectedChatKey] = useState<string | null>(null);
	const [filter, setFilter] = useState<FleetFilter>("all");
	const botId = bots.some((bot) => bot.id === selectedBotId)
		? selectedBotId
		: lastBotId && bots.some((bot) => bot.id === lastBotId)
			? lastBotId
			: (bots[0]?.id ?? "");

	const selectBot = useCallback(
		(nextBotId: string) => {
			setLastBotId(nextBotId);
			setSelectedBotId(nextBotId);
			setSelectedChatKey((current) => {
				if (!current) return null;
				const currentChat = chats.find((chat) => chat.key === current);
				if (!currentChat || currentChat.botId === nextBotId) return current;
				return newestNotClosed(nextBotId, chats, chatStates);
			});
		},
		[chatStates, chats, setLastBotId],
	);

	const selectChat = useCallback(
		(chatKey: string, nextBotId: string) => {
			setSelectedChatKey(chatKey);
			setSelectedBotId(nextBotId);
			setLastBotId(nextBotId);
		},
		[setLastBotId],
	);

	const startThread = useCallback(
		(nextBotId: string) => {
			setSelectedBotId(nextBotId);
			setSelectedChatKey(null);
			setLastBotId(nextBotId);
		},
		[setLastBotId],
	);

	const onChatCreated = useCallback(
		(chatKey: string) => {
			setSelectedChatKey(chatKey);
			setSelectedBotId(botId);
			setLastBotId(botId);
		},
		[botId, setLastBotId],
	);

	const onArchived = useCallback(() => {
		setSelectedChatKey(null);
	}, []);

	useEffect(() => {
		function onOpenChat(event: Event) {
			if (!(event instanceof CustomEvent)) return;
			const detail = event.detail as { chatKey?: unknown; botId?: unknown };
			if (
				typeof detail?.chatKey !== "string" ||
				typeof detail.botId !== "string"
			) {
				return;
			}
			event.preventDefault();
			setSelectedChatKey(detail.chatKey);
			setSelectedBotId(detail.botId);
			setLastBotId(detail.botId);
		}
		window.addEventListener("cadmus:open-chat", onOpenChat);
		return () => {
			window.removeEventListener("cadmus:open-chat", onOpenChat);
		};
	}, [setLastBotId]);

	return (
		<CockpitFrame
			bots={bots.map((bot) => ({ id: bot.id, name: bot.name }))}
			onSelectBot={selectBot}
			fleet={
				<FleetDeck
					selectedBotId={botId}
					selectedChatKey={selectedChatKey}
					filter={filter}
					onFilterChange={setFilter}
					onSelectBot={selectBot}
					onSelectChat={selectChat}
					onNewThread={startThread}
				/>
			}
			stage={
				<DesktopChatConsole
					chatKey={selectedChatKey}
					botId={botId}
					onChatCreated={onChatCreated}
					onArchived={onArchived}
				/>
			}
			telemetry={<TelemetryDeck chatKey={selectedChatKey} botId={botId} />}
		/>
	);
}
