import { CadmusClient, type ConnectionStatus } from "@cadmus/contract/client";
import type {
	BotRecord,
	ChatRecord,
	ChatStatusRecord,
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
	status?: ChatStatusRecord;
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
	directoryDetailReady: boolean;
	directoryError?: string;
	refreshDirectory: () => Promise<void>;
	subscribeEvents: (listener: (event: ServerEvent) => void) => () => void;
	toggleCollapsed: (botId: string) => void;
	markChatSeen: (chatKey: string) => number | undefined;
	setLastBotId: (id: string) => void;
	familyId: string;
	switchFamily: (familyId: string) => Promise<void>;
	archiveChat: (chatKey: string) => Promise<void>;
	deleteChat: (chatKey: string) => Promise<void>;
	retryChat: (chatKey: string) => Promise<void>;
	noteUserText: (chatKey: string, text: string) => void;
	markFailed: (chatKey: string, reason: string) => void;
	createChatAndSubmit: (botId: string, text: string) => Promise<void>;
	queueTurn: (turn: OutboundTurn) => void;
	refreshChatStatus: (chatKey: string) => Promise<void>;
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
	const [familyId, setFamilyId] = useState(authConfig.familyId);
	const [teamLeaderBotId, setTeamLeaderBotId] = useState<string | undefined>();
	const [directoryReady, setDirectoryReady] = useState(false);
	const [directoryDetailReady, setDirectoryDetailReady] = useState(false);
	const [directoryError, setDirectoryError] = useState<string | undefined>();
	const directoryScopeRef = useRef(
		`${authConfig.accountId}:${authConfig.familyId}`,
	);
	const directoryDetailRef = useRef(false);

	// Stop clears busy before `turn.interrupt` finishes. A chat.status read
	// that started while the turn was still running must not put Working back.
	const holdIdle = useRef(new Set<string>());
	const statusEpoch = useRef(new Map<string, number>());
	const bumpStatusEpoch = useCallback((chatKey: string) => {
		const next = (statusEpoch.current.get(chatKey) ?? 0) + 1;
		statusEpoch.current.set(chatKey, next);
		return next;
	}, []);
	const patchState = useCallback((chatKey: string, patch: ChatLiveState) => {
		if (patch.busy === true) holdIdle.current.delete(chatKey);
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

	const refreshChatStatus = useCallback(
		async (chatKey: string) => {
			const epoch = bumpStatusEpoch(chatKey);
			const status = await client.callRpc<{ status?: ChatStatusRecord }>(
				"chat.status",
				{ chatKey },
			);
			if (statusEpoch.current.get(chatKey) !== epoch) return;
			if (status.ok && status.result?.status) {
				const reported = status.result.status;
				const busy = holdIdle.current.has(chatKey)
					? false
					: Boolean(reported.busy);
				patchState(chatKey, {
					status: busy === reported.busy ? reported : { ...reported, busy },
					busy,
				});
			}
		},
		[bumpStatusEpoch, client, patchState],
	);

	const clearDirectory = useCallback((scope: string) => {
		directoryScopeRef.current = scope;
		directoryDetailRef.current = false;
		setDirectoryReady(false);
		setDirectoryDetailReady(false);
		setDirectoryError(undefined);
		setBots([]);
		setChats([]);
		setChatStates({});
		setTeamLeaderBotId(undefined);
	}, []);

	const refreshDirectory = useCallback(async () => {
		const scope = `${client.getAccountId()}:${client.getFamilyId()}`;
		if (directoryScopeRef.current !== scope) {
			clearDirectory(scope);
		}
		const keep = directoryDetailRef.current;
		try {
			const [botRes, chatRes, familyRes] = await Promise.all([
				client.callRpc<{ bots: BotRecord[] }>("bot.list"),
				client.callRpc<{ chats: ChatRecord[] }>("chat.list", {
					kinds: ["direct"],
				}),
				client.callRpc<{ family?: { teamLeaderBotId?: string } }>("family.get"),
			]);
			if (`${client.getAccountId()}:${client.getFamilyId()}` !== scope) return;
			if (!botRes.ok || !chatRes.ok) {
				throw new Error(
					botRes.error?.message ??
						chatRes.error?.message ??
						"Could not load bots",
				);
			}
			const leader = familyRes.ok
				? familyRes.result?.family?.teamLeaderBotId
				: undefined;
			setTeamLeaderBotId(leader && leader.length > 0 ? leader : undefined);
			setBots(botRes.result?.bots ?? []);
			const listed = (chatRes.result?.chats ?? []).filter(
				(chat) => !chat.closed,
			);
			setChats(listed);
			setDirectoryReady(true);
			setDirectoryError(undefined);
			await Promise.all(
				listed.map(async (chat) => {
					try {
						await refreshChatStatus(chat.key);
						const detail = await client.callRpc<{
							messages?: Array<{
								role: string;
								text: string;
								timestamp?: number;
							}>;
						}>("chat.get", { chatKey: chat.key });
						if (!detail.ok) return;
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
					} catch {
						/* one chat preview must not block the directory */
					}
				}),
			);
			if (`${client.getAccountId()}:${client.getFamilyId()}` !== scope) return;
			directoryDetailRef.current = true;
			setDirectoryDetailReady(true);
		} catch (err) {
			if (`${client.getAccountId()}:${client.getFamilyId()}` !== scope) return;
			if (!keep) {
				directoryDetailRef.current = false;
				setDirectoryReady(false);
				setDirectoryDetailReady(false);
				setDirectoryError(
					err instanceof Error && err.message
						? err.message
						: "Could not load bots",
				);
			}
		}
	}, [clearDirectory, client, patchState, refreshChatStatus]);

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
				if (!event.payload.busy) holdIdle.current.delete(event.payload.chatKey);
				if (event.payload.busy && holdIdle.current.has(event.payload.chatKey)) {
					return;
				}
				setChatStates((prev) => {
					const current = prev[event.payload.chatKey];
					const busy = event.payload.busy;
					return {
						...prev,
						[event.payload.chatKey]: {
							...current,
							busy,
							streamText: busy ? current?.streamText : "",
							status: current?.status
								? { ...current.status, busy }
								: current?.status,
						},
					};
				});
				return;
			}
			if (event.type === "turn.delta") {
				if (holdIdle.current.has(event.payload.chatKey)) return;
				setChatStates((prev) => {
					const current = prev[event.payload.chatKey];
					return {
						...prev,
						[event.payload.chatKey]: {
							...current,
							busy: true,
							streamText:
								event.payload.kind === "text"
									? `${current?.streamText ?? ""}${event.payload.delta}`
									: current?.streamText,
							status: current?.status
								? { ...current.status, busy: true }
								: current?.status,
						},
					};
				});
				return;
			}
			if (event.type === "turn.tool_call") {
				if (holdIdle.current.has(event.payload.chatKey)) return;
				setChatStates((prev) => {
					const current = prev[event.payload.chatKey];
					return {
						...prev,
						[event.payload.chatKey]: {
							...current,
							busy: true,
							lastToolName: event.payload.toolName,
							status: current?.status
								? { ...current.status, busy: true }
								: current?.status,
						},
					};
				});
				return;
			}
			if (event.type === "chat.tasks") {
				const open = event.payload.tasks.filter(
					(task) => task.status !== "done",
				).length;
				const done = event.payload.tasks.filter(
					(task) => task.status === "done",
				).length;
				setChatStates((prev) => {
					const current = prev[event.payload.chatKey];
					if (!current?.status) return prev;
					return {
						...prev,
						[event.payload.chatKey]: {
							...current,
							status: {
								...current.status,
								tasks: {
									open,
									done,
									loopRound: event.payload.loop.round,
								},
							},
						},
					};
				});
				return;
			}
			if (event.type === "turn.completed") {
				holdIdle.current.delete(event.payload.chatKey);
				bumpStatusEpoch(event.payload.chatKey);
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
						status: current?.status
							? { ...current.status, busy: false }
							: current?.status,
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
	}, [bumpStatusEpoch, client, patchState, persistFailed, refreshDirectory]);

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

	const switchFamily = useCallback(
		async (nextFamilyId: string) => {
			const trimmed = nextFamilyId.trim();
			if (!trimmed) return;
			try {
				const raw = localStorage.getItem(STORAGE_KEY);
				const parsed = raw
					? (JSON.parse(raw) as Partial<DevAuthConfig>)
					: authConfig;
				localStorage.setItem(
					STORAGE_KEY,
					JSON.stringify({ ...parsed, familyId: trimmed }),
				);
			} catch {
				/* private mode */
			}
			client.setFamilyId(trimmed);
			setFamilyId(trimmed);
			clearDirectory(`${client.getAccountId()}:${trimmed}`);
			await refreshDirectory();
		},
		[authConfig, clearDirectory, client, refreshDirectory],
	);

	const archiveChat = useCallback(
		async (chatKey: string) => {
			await client.callRpc("chat.close", { chatKey });
			setChats((prev) => prev.filter((chat) => chat.key !== chatKey));
		},
		[client],
	);

	const deleteChat = useCallback(
		async (chatKey: string) => {
			await client.callRpc("chat.delete", { chatKey });
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
			patchState(chatKey, { busy: true });
			void client.callRpc("turn.submit", { chatKey, text });
			await refreshDirectory();
			await navigate({
				to: "/chat/$chatKey",
				params: { chatKey },
				search: { view: "chat" },
			});
		},
		[
			client,
			navigate,
			noteUserText,
			patchState,
			refreshDirectory,
			setLastBotId,
		],
	);

	const markFailed = useCallback(
		(chatKey: string, reason: string) => {
			holdIdle.current.add(chatKey);
			bumpStatusEpoch(chatKey);
			setChatStates((prev) => {
				const current = prev[chatKey];
				const next = {
					...current,
					busy: false,
					failedReason: reason,
					lastUserText: current?.lastUserText,
					status: current?.status
						? { ...current.status, busy: false }
						: current?.status,
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
		[bumpStatusEpoch, persistFailed],
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
			familyId,
			switchFamily,
			directoryReady,
			directoryDetailReady,
			directoryError,
			refreshDirectory,
			subscribeEvents: (listener) => client.subscribe(listener),
			toggleCollapsed,
			markChatSeen,
			setLastBotId,
			archiveChat,
			deleteChat,
			retryChat,
			noteUserText,
			markFailed,
			createChatAndSubmit,
			queueTurn,
			refreshChatStatus,
		}),
		[
			archiveChat,
			deleteChat,
			createChatAndSubmit,
			authConfig,
			bots,
			chatStates,
			chats,
			client,
			collapsed,
			connectionStatus,
			familyId,
			lastBotId,
			switchFamily,
			teamLeaderBotId,
			directoryReady,
			directoryDetailReady,
			directoryError,
			lastSeen,
			markChatSeen,
			markFailed,
			noteUserText,
			refreshDirectory,
			queueTurn,
			refreshChatStatus,
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
