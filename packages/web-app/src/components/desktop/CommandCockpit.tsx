import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
	type JSX,
	type ReactNode,
	useCallback,
	useEffect,
	useState,
} from "react";
import { useCadmus } from "@/context/CadmusContext";
import { CockpitFrame } from "./CockpitFrame";
import { DesktopChatConsole } from "./DesktopChatConsole";
import { FleetDeck } from "./FleetDeck";
import { TelemetryDeck } from "./TelemetryDeck";

type FleetFilter = "all" | "running" | "needs";

/** Strips the `/app` router basepath prefix so sub-route checks stay path-relative. */
export function stripAppBasepath(pathname: string): string {
	if (pathname === "/app" || pathname === "/app/") return "/";
	if (pathname.startsWith("/app/")) return pathname.slice("/app".length);
	return pathname;
}

export function DesktopCockpitShell({
	children,
}: {
	children: ReactNode;
}): JSX.Element {
	const { bots, chats, lastBotId, setLastBotId } = useCadmus();
	const routerState = useRouterState();
	const navigate = useNavigate();
	const pathname = stripAppBasepath(routerState.location.pathname);
	const search = routerState.location.search as Record<string, unknown>;

	const chatMatch = pathname.match(/^\/chat\/([^/]+)/);
	const activeChatKey = chatMatch?.[1]
		? decodeURIComponent(chatMatch[1])
		: null;

	const botMatch = pathname.match(/^\/bot\/([^/]+)/);
	const urlBotId =
		botMatch?.[1] && botMatch[1] !== "new"
			? decodeURIComponent(botMatch[1])
			: null;
	const queryBotId = typeof search?.bot === "string" ? search.bot : null;
	const chatBotId = activeChatKey
		? chats.find((c) => c.key === activeChatKey)?.botId
		: null;

	const [localBotId, setLocalBotId] = useState(
		() => lastBotId ?? bots[0]?.id ?? "",
	);
	const [filter, setFilter] = useState<FleetFilter>("all");

	const effectiveBotId =
		urlBotId && bots.some((b) => b.id === urlBotId)
			? urlBotId
			: chatBotId && bots.some((b) => b.id === chatBotId)
				? chatBotId
				: queryBotId && bots.some((b) => b.id === queryBotId)
					? queryBotId
					: bots.some((b) => b.id === localBotId)
						? localBotId
						: lastBotId && bots.some((b) => b.id === lastBotId)
							? lastBotId
							: (bots[0]?.id ?? "");

	const selectBot = useCallback(
		(nextBotId: string) => {
			setLastBotId(nextBotId);
			setLocalBotId(nextBotId);
			if (pathname.startsWith("/chat/") || pathname.startsWith("/bot/")) {
				void navigate({ to: "/" });
			}
		},
		[navigate, pathname, setLastBotId],
	);

	const selectChat = useCallback(
		(chatKey: string, nextBotId: string) => {
			setLastBotId(nextBotId);
			setLocalBotId(nextBotId);
			void navigate({
				to: "/chat/$chatKey",
				params: { chatKey },
				search: { view: "chat" },
			});
		},
		[navigate, setLastBotId],
	);

	const startThread = useCallback(
		(nextBotId: string) => {
			setLastBotId(nextBotId);
			setLocalBotId(nextBotId);
			void navigate({ to: "/" });
		},
		[navigate, setLastBotId],
	);

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
			setLastBotId(detail.botId);
			setLocalBotId(detail.botId);
			void navigate({
				to: "/chat/$chatKey",
				params: { chatKey: detail.chatKey },
				search: { view: "chat" },
			});
		}
		document.addEventListener("cadmus:open-chat", onOpenChat);
		return () => {
			document.removeEventListener("cadmus:open-chat", onOpenChat);
		};
	}, [navigate, setLastBotId]);

	return (
		<CockpitFrame
			bots={bots.map((bot) => ({ id: bot.id, name: bot.name }))}
			onSelectBot={selectBot}
			fleet={
				<FleetDeck
					selectedBotId={effectiveBotId}
					selectedChatKey={activeChatKey}
					filter={filter}
					onFilterChange={setFilter}
					onSelectBot={selectBot}
					onSelectChat={selectChat}
					onNewThread={startThread}
				/>
			}
			stage={children}
			telemetry={
				<TelemetryDeck
					chatKey={activeChatKey}
					botId={effectiveBotId}
					isStageChat={Boolean(activeChatKey)}
				/>
			}
		/>
	);
}

export function CommandCockpit(): JSX.Element {
	const { bots, lastBotId } = useCadmus();
	const navigate = useNavigate();
	const botId =
		lastBotId && bots.some((b) => b.id === lastBotId)
			? lastBotId
			: (bots[0]?.id ?? "");

	return (
		<DesktopCockpitShell>
			<DesktopChatConsole
				chatKey={null}
				botId={botId}
				onChatCreated={(chatKey) => {
					void navigate({
						to: "/chat/$chatKey",
						params: { chatKey },
						search: { view: "chat" },
					});
				}}
			/>
		</DesktopCockpitShell>
	);
}
