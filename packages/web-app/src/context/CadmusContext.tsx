import { CadmusClient, type ConnectionStatus } from "@cadmus/contract/client";
import type {
	BotRecord,
	ChatRecord,
	ServerEvent,
} from "@cadmus/contract/types";
import { useNavigate } from "@tanstack/react-router";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { ChatLiveSlice } from "@/lib/needs-you";
import {
	type CollapsedMap,
	type FailedMap,
	type LastSeenMap,
	loadCollapsed,
	loadFailed,
	loadLastBotId,
	loadLastSeen,
	saveCollapsed,
	saveFailed,
	saveLastBotId,
	saveLastSeen,
} from "@/lib/storage";

export interface DevAuthConfig {
	userId: string;
	accountId: string;
	familyId: string;
	token: string;
}

const STORAGE_KEY = "cadmus.dev.config";

const DEFAULT_AUTH_CONFIG: DevAuthConfig = {
	userId: "dev",
	accountId: "default-account",
	familyId: "default",
	token: "dev-cadmus-secret",
};

function loadStoredConfig(): DevAuthConfig {
	if (typeof window === "undefined") return DEFAULT_AUTH_CONFIG;
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) return DEFAULT_AUTH_CONFIG;
		const parsed = JSON.parse(raw) as Partial<DevAuthConfig>;
		return {
			userId: parsed.userId?.trim() || DEFAULT_AUTH_CONFIG.userId,
			accountId: parsed.accountId?.trim() || DEFAULT_AUTH_CONFIG.accountId,
			familyId: parsed.familyId?.trim() || DEFAULT_AUTH_CONFIG.familyId,
			token: parsed.token?.trim() || DEFAULT_AUTH_CONFIG.token,
		};
	} catch {
		return DEFAULT_AUTH_CONFIG;
	}
}

export type ChatLiveState = ChatLiveSlice & {
	streamText?: string;
	lastToolName?: string;
};

export interface CadmusContextValue {
	client: CadmusClient;
	authConfig: DevAuthConfig;
	connectionStatus: ConnectionStatus;
	bots: BotRecord[];
	chats: ChatRecord[];
	chatStates: Record<string, ChatLiveState>;
	lastSeen: LastSeenMap;
	collapsed: CollapsedMap;
	lastBotId?: string;
	teamLeaderBotId?: string;
	directoryReady: boolean;
	refreshDirectory: () => Promise<void>;
	subscribeEvents: (listener: (event: ServerEvent) => void) => () => void;
	toggleCollapsed: (botId: string) => void;
	markChatSeen: (chatKey: string) => number | undefined;
	setLastBotId: (id: string) => void;
	archiveChat: (chatKey: string) => Promise<void>;
	retryChat: (chatKey: string) => Promise<void>;
	noteUserText: (chatKey: string, text: string) => void;
	markFailed: (chatKey: string, reason: string) => void;
	createChatAndSubmit: (botId: string, text: string) => Promise<void>;
	queueTurn: (turn: OutboundTurn) => void;
}

export interface OutboundTurn {
	chatKey: string;
	text: string;
	clientMsgId: string;
	whenBusy?: "queue" | "steer" | "reject";
}

const CadmusContext = createContext<CadmusContextValue | null>(null);

function isFailedTurn(status?: string, reason?: string): boolean {
	if (status === "unanswered") return true;
	if (!reason) return false;
	return /abort|error|fail/i.test(reason);
}

export function CadmusProvider({
	children,
	clientOverride,
	initialConfig,
}: {
	children: ReactNode;
	clientOverride?: CadmusClient;
	initialConfig?: Partial<DevAuthConfig>;
}) {
	const [authConfig] = useState<DevAuthConfig>(() => ({
		...loadStoredConfig(),
		...initialConfig,
	}));
	const client = useMemo(() => {
		if (clientOverride) return clientOverride;
		return new CadmusClient({
			baseUrl: "",
			userId: authConfig.userId,
			accountId: authConfig.accountId,
			familyId: authConfig.familyId,
			token: authConfig.token,
		});
	}, [authConfig, clientOverride]);

	const navigate = useNavigate();
	const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(
		client.getStatus(),
	);
	const [bots, setBots] = useState<BotRecord[]>([]);
	const [chats, setChats] = useState<ChatRecord[]>([]);
	const [chatStates, setChatStates] = useState<Record<string, ChatLiveState>>(
		() => {
			const failed = loadFailed();
			const next: Record<string, ChatLiveState> = {};
			for (const [key, value] of Object.entries(failed)) {
				next[key] = {
					failedReason: value.reason,
					lastUserText: value.lastUserText,
					lastBotAt: value.at,
				};
			}
			return next;
		},
	);
	const [lastSeen, setLastSeen] = useState<LastSeenMap>(loadLastSeen);
	const [collapsed, setCollapsed] = useState<CollapsedMap>(loadCollapsed);
	const [lastBotId, setLastBotIdState] = useState<string | undefined>(
		loadLastBotId,
	);
	const [teamLeaderBotId, setTeamLeaderBotId] = useState<string | undefined>();
	const [directoryReady, setDirectoryReady] = useState(false);

	const patchState = useCallback((chatKey: string, patch: ChatLiveState) => {
		setChatStates((prev) => ({
			...prev,
			[chatKey]: { ...prev[chatKey], ...patch },
		}));
	}, []);

	const persistFailed = useCallback((map: FailedMap) => {
		saveFailed(map);
	}, []);
	const outbox = useRef<OutboundTurn[]>([]);

	const delivery = useRef(Promise.resolve());
	const deliverTurn = useCallback(
		(turn: OutboundTurn) => {
			delivery.current = delivery.current
				.catch(() => undefined)
				.then(async () => {
					await client.callRpc("turn.submit", {
						chatKey: turn.chatKey,
						text: turn.text,
						clientMsgId: turn.clientMsgId,
						...(turn.whenBusy ? { whenBusy: turn.whenBusy } : {}),
					});
				});
		},
		[client],
	);

	const queueTurn = useCallback(
		(turn: OutboundTurn) => {
			if (client.getStatus() === "connected") {
				deliverTurn(turn);
				return;
			}
			outbox.current.push(turn);
		},
		[client, deliverTurn],
	);

	const refreshDirectory = useCallback(async () => {
		try {
			const [botRes, chatRes, familyRes] = await Promise.all([
				client.callRpc<{ bots: BotRecord[] }>("bot.list"),
				client.callRpc<{ chats: ChatRecord[] }>("chat.list", {
					kinds: ["direct"],
				}),
				client.callRpc<{ family?: { teamLeaderBotId?: string } }>("family.get"),
			]);
			const leader = familyRes.ok
				? familyRes.result?.family?.teamLeaderBotId
				: undefined;
			setTeamLeaderBotId(leader && leader.length > 0 ? leader : undefined);
			if (botRes.ok && botRes.result?.bots) {
				setBots(botRes.result.bots);
			}
			let listed: ChatRecord[] = [];
			if (chatRes.ok && chatRes.result?.chats) {
				listed = chatRes.result.chats.filter((chat) => !chat.closed);
				setChats(listed);
			}
			await Promise.all(
				listed.map(async (chat) => {
					const status = await client.callRpc<{
						status?: { busy?: boolean };
					}>("chat.status", { chatKey: chat.key });
					if (status.ok && status.result?.status) {
						patchState(chat.key, { busy: Boolean(status.result.status.busy) });
					}
					const detail = await client.callRpc<{
						messages?: Array<{
							role: string;
							text: string;
							timestamp?: number;
						}>;
					}>("chat.get", { chatKey: chat.key });
					const messages = detail.result?.messages;
					const lastAssistant = messages?.findLast(
						(message) => message.role === "assistant" && message.text.trim(),
					);
					const firstUser = messages?.find(
						(message) => message.role === "user" && message.text.trim(),
					);
					if (lastAssistant) {
						patchState(chat.key, {
							lastBotText: lastAssistant.text,
							...(lastAssistant.timestamp
								? { lastBotAt: lastAssistant.timestamp }
								: {}),
						});
					}
					if (firstUser) {
						setChatStates((prev) => {
							if (prev[chat.key]?.lastUserText?.trim()) return prev;
							return {
								...prev,
								[chat.key]: {
									...prev[chat.key],
									lastUserText: firstUser.text,
								},
							};
						});
					}
				}),
			);
		} finally {
			setDirectoryReady(true);
		}
	}, [client, patchState]);

	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let attempt = 0;
		let closed = false;
		let online = false;
		let lost = false;
		const RECONNECT_BASE_MS = 400;
		const RECONNECT_MAX_MS = 8_000;
		const off = client.onStatusChange((status) => {
			setConnectionStatus(status);
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
			if (closed) return;
			if (status === "disconnected") {
				if (online) lost = true;
				online = false;
				const delay = Math.min(
					RECONNECT_MAX_MS,
					RECONNECT_BASE_MS * 2 ** attempt,
				);
				attempt += 1;
				timer = setTimeout(() => {
					if (!closed) client.connectWebSocket();
				}, delay);
				return;
			}
			if (status !== "connected") return;
			attempt = 0;
			const recovered = lost;
			lost = false;
			online = true;
			const pending = outbox.current.splice(0);
			for (const turn of pending) deliverTurn(turn);
			if (recovered) void refreshDirectory();
		});
		client.connectWebSocket();
		void refreshDirectory();
		return () => {
			closed = true;
			if (timer) clearTimeout(timer);
			off();
			client.close();
		};
	}, [client, deliverTurn, refreshDirectory]);

	useEffect(() => {
		return client.subscribe((event: ServerEvent) => {
			if (event.type === "chat.state") {
				patchState(event.payload.chatKey, { busy: event.payload.busy });
				if (!event.payload.busy) {
					patchState(event.payload.chatKey, { streamText: "" });
				}
				return;
			}
			if (event.type === "turn.delta") {
				if (event.payload.kind === "text") {
					setChatStates((prev) => {
						const current = prev[event.payload.chatKey];
						return {
							...prev,
							[event.payload.chatKey]: {
								...current,
								busy: true,
								streamText: `${current?.streamText ?? ""}${event.payload.delta}`,
							},
						};
					});
				} else {
					patchState(event.payload.chatKey, { busy: true });
				}
				return;
			}
			if (event.type === "turn.tool_call") {
				patchState(event.payload.chatKey, {
					busy: true,
					lastToolName: event.payload.toolName,
				});
				return;
			}
			if (event.type === "turn.completed") {
				const failed = isFailedTurn(event.payload.status, event.payload.reason);
				const at = Date.now();
				setChatStates((prev) => {
					const current = prev[event.payload.chatKey];
					const next: ChatLiveState = {
						...current,
						busy: false,
						streamText: "",
						failedReason: failed
							? (event.payload.reason ?? "unanswered")
							: undefined,
						lastBotText: failed
							? current?.lastBotText
							: (event.payload.text ?? current?.lastBotText),
						lastBotAt: failed ? current?.lastBotAt : at,
					};
					const failedMap = loadFailed();
					if (next.failedReason) {
						failedMap[event.payload.chatKey] = {
							reason: next.failedReason,
							lastUserText: next.lastUserText ?? "",
							at,
						};
					} else {
						delete failedMap[event.payload.chatKey];
					}
					persistFailed(failedMap);
					return { ...prev, [event.payload.chatKey]: next };
				});
				void refreshDirectory();
				return;
			}
			if (event.type === "bot.message") {
				patchState(event.payload.chatKey, {
					lastBotText: event.payload.reply ?? event.payload.text,
					lastBotAt: event.payload.when,
				});
			}
		});
	}, [client, patchState, persistFailed, refreshDirectory]);

	const toggleCollapsed = useCallback((botId: string) => {
		setCollapsed((prev) => {
			const next = { ...prev, [botId]: !prev[botId] };
			saveCollapsed(next);
			return next;
		});
	}, []);

	const markChatSeen = useCallback((chatKey: string) => {
		const previous = loadLastSeen()[chatKey];
		const next = { ...loadLastSeen(), [chatKey]: Date.now() };
		saveLastSeen(next);
		setLastSeen(next);
		return previous;
	}, []);

	const setLastBotId = useCallback((id: string) => {
		saveLastBotId(id);
		setLastBotIdState(id);
	}, []);

	const archiveChat = useCallback(
		async (chatKey: string) => {
			await client.callRpc("chat.close", { chatKey });
			setChats((prev) => prev.filter((chat) => chat.key !== chatKey));
		},
		[client],
	);

	const retryChat = useCallback(
		async (chatKey: string) => {
			const state = chatStates[chatKey];
			const stored = loadFailed()[chatKey];
			let text = (state?.lastUserText ?? stored?.lastUserText)?.trim();
			if (!text) {
				const detail = await client.callRpc<{
					messages?: Array<{ role: string; text: string }>;
				}>("chat.get", { chatKey });
				const lastUser = detail.result?.messages?.findLast(
					(message) => message.role === "user" && message.text.trim(),
				);
				text = lastUser?.text.trim();
			}
			if (!text) return;
			patchState(chatKey, {
				failedReason: undefined,
				lastUserText: text,
				busy: true,
			});
			void client.callRpc("turn.submit", { chatKey, text });
			const failedMap = loadFailed();
			delete failedMap[chatKey];
			persistFailed(failedMap);
		},
		[chatStates, client, patchState, persistFailed],
	);

	const noteUserText = useCallback(
		(chatKey: string, text: string) => {
			patchState(chatKey, { lastUserText: text });
		},
		[patchState],
	);

	const createChatAndSubmit = useCallback(
		async (botId: string, text: string) => {
			setLastBotId(botId);
			const created = await client.callRpc<{ chat: { key: string } }>(
				"chat.create",
				{ botId },
			);
			if (!created.ok || !created.result?.chat) return;
			const chatKey = created.result.chat.key;
			noteUserText(chatKey, text);
			void client.callRpc("turn.submit", { chatKey, text });
			await refreshDirectory();
			await navigate({
				to: "/chat/$chatKey",
				params: { chatKey },
				search: { view: "chat" },
			});
		},
		[client, navigate, noteUserText, refreshDirectory, setLastBotId],
	);

	const markFailed = useCallback(
		(chatKey: string, reason: string) => {
			setChatStates((prev) => {
				const current = prev[chatKey];
				const next = {
					...current,
					busy: false,
					failedReason: reason,
					lastUserText: current?.lastUserText,
				};
				const failedMap = loadFailed();
				failedMap[chatKey] = {
					reason,
					lastUserText: next.lastUserText ?? "",
					at: Date.now(),
				};
				persistFailed(failedMap);
				return { ...prev, [chatKey]: next };
			});
		},
		[persistFailed],
	);

	const value = useMemo<CadmusContextValue>(
		() => ({
			client,
			authConfig,
			connectionStatus,
			bots,
			chats,
			chatStates,
			lastSeen,
			collapsed,
			lastBotId,
			teamLeaderBotId,
			directoryReady,
			refreshDirectory,
			subscribeEvents: (listener) => client.subscribe(listener),
			toggleCollapsed,
			markChatSeen,
			setLastBotId,
			archiveChat,
			retryChat,
			noteUserText,
			markFailed,
			createChatAndSubmit,
			queueTurn,
		}),
		[
			archiveChat,
			createChatAndSubmit,
			authConfig,
			bots,
			chatStates,
			chats,
			client,
			collapsed,
			connectionStatus,
			lastBotId,
			teamLeaderBotId,
			directoryReady,
			lastSeen,
			markChatSeen,
			markFailed,
			noteUserText,
			refreshDirectory,
			queueTurn,
			retryChat,
			setLastBotId,
			toggleCollapsed,
		],
	);

	return (
		<CadmusContext.Provider value={value}>{children}</CadmusContext.Provider>
	);
}

export function useCadmus(): CadmusContextValue {
	const value = useContext(CadmusContext);
	if (!value) throw new Error("useCadmus must be used within CadmusProvider");
	return value;
}
