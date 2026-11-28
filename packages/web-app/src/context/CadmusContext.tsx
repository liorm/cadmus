import { CadmusClient, type ConnectionStatus } from "@cadmus/contract/client";
import type {
	BotRecord,
	ChatRecord,
	ChatStatusRecord,
	ChatTask,
	ChatTaskLoopState,
	FamilyRecord,
	HarvestNote,
	RawTranscriptEntry,
	ServerEvent,
	TranscriptMessageView,
} from "@cadmus/contract/types";
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
	onSessionEnded,
	onSessionTokens,
	REFRESH_MARGIN_MS,
	refreshSession,
	selectedAccountId,
} from "@/lib/session";
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
	setStorageScope,
} from "@/lib/storage";

export interface DevAuthConfig {
	userId: string;
	accountId: string;
	familyId: string;
	token: string;
}

const STORAGE_KEY = "cadmus.dev.config";
const REFRESH_RETRY_MS = 30_000;
const DEFAULT_FAMILY_ID = "default";
const CHAT_PAGE_LIMIT = 100;

/** Family choice only. Credentials are never stored or invented here. */
function loadStoredFamilyId(): string {
	if (typeof window === "undefined") return DEFAULT_FAMILY_ID;
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) return DEFAULT_FAMILY_ID;
		const parsed = JSON.parse(raw) as Partial<DevAuthConfig>;
		if (parsed.token || parsed.userId || parsed.accountId) {
			const familyId = parsed.familyId?.trim() || DEFAULT_FAMILY_ID;
			window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ familyId }));
			return familyId;
		}
		return parsed.familyId?.trim() || DEFAULT_FAMILY_ID;
	} catch {
		return DEFAULT_FAMILY_ID;
	}
}

export type ActiveToolState = {
	toolCallId: string;
	toolName: string;
	args?: Record<string, unknown>;
	startedAt: number;
};

export type ChatLiveState = ChatLiveSlice & {
	streamText?: string;
	lastToolName?: string;
	activeTool?: ActiveToolState;
	liveTools?: import("@/lib/group-tool-runs").ToolExecutionDetail[];
	status?: ChatStatusRecord;
};

export interface ActiveChatState {
	chatKey: string | null;
	messages: TranscriptMessageView[];
	entries: RawTranscriptEntry[];
	tasks: ChatTask[];
	notes: HarvestNote[];
	taskLoop?: ChatTaskLoopState;
	hasMore: boolean;
	oldestEntryId?: number;
	loadingOlder: boolean;
}

const EMPTY_ACTIVE_CHAT: ActiveChatState = {
	chatKey: null,
	messages: [],
	entries: [],
	tasks: [],
	notes: [],
	hasMore: false,
	oldestEntryId: undefined,
	loadingOlder: false,
};

export interface CreateFamilyInput {
	familyId: string;
	name: string;
	description?: string;
	timezone?: string;
}

export interface CadmusContextValue {
	client: CadmusClient;
	authConfig: DevAuthConfig;
	connectionStatus: ConnectionStatus;
	bots: BotRecord[];
	chats: ChatRecord[];
	families: FamilyRecord[];
	chatStates: Record<string, ChatLiveState>;
	compactingChats: Record<string, boolean>;
	lastSeen: LastSeenMap;
	collapsed: CollapsedMap;
	lastBotId?: string;
	teamLeaderBotId?: string;
	directoryReady: boolean;
	directoryDetailReady: boolean;
	directoryError?: string;
	skipTenantSync: boolean;
	refreshDirectory: () => Promise<void>;
	subscribeEvents: (listener: (event: ServerEvent) => void) => () => void;
	toggleCollapsed: (botId: string) => void;
	markChatSeen: (chatKey: string) => number | undefined;
	setLastBotId: (id: string) => void;
	familyId: string;
	switchFamily: (familyId: string) => Promise<void>;
	createFamily: (input: CreateFamilyInput) => Promise<FamilyRecord | null>;
	updateFamily: (
		familyId: string,
		patch: {
			name?: string;
			timezone?: string;
			teamLeaderBotId?: string | null;
		},
	) => Promise<boolean>;
	deleteFamily: (familyId: string) => Promise<boolean>;
	retryChat: (chatKey: string) => Promise<void>;
	noteUserText: (chatKey: string, text: string) => void;
	markFailed: (chatKey: string, reason: string) => void;
	queueTurn: (turn: OutboundTurn) => void;
	refreshChatStatus: (chatKey: string) => Promise<void>;
	loadBotChat: (chatKey: string) => Promise<void>;
	loadOlderMessages: (chatKey: string) => Promise<void>;
	activeChat: ActiveChatState;
	setActiveChatTranscript: (
		chatKey: string,
		messages: TranscriptMessageView[],
		tasks?: ChatTask[],
	) => void;
	setActiveChatTasks: (chatKey: string, tasks: ChatTask[]) => void;
	clearActiveChat: (chatKey?: string) => void;
}

export interface OutboundTurn {
	chatKey: string;
	text: string;
	clientMsgId: string;
	whenBusy?: "queue" | "steer" | "reject";
}

interface ChatGetResponse {
	chat: ChatRecord;
	busy: boolean;
	compacting?: boolean;
	messages: TranscriptMessageView[];
	entries?: RawTranscriptEntry[];
	hasMore?: boolean;
	oldestEntryId?: number;
	notes?: HarvestNote[];
	tasks?: ChatTask[];
	taskLoop?: ChatTaskLoopState;
}

const CadmusContext = createContext<CadmusContextValue | null>(null);

function isFailedTurn(status?: string, reason?: string): boolean {
	if (status === "unanswered") return true;
	if (!reason) return false;
	return /abort|error|fail/i.test(reason);
}

function dedupeById<T extends { id: number }>(older: T[], current: T[]): T[] {
	const seen = new Set(older.map((item) => item.id));
	const tail = current.filter((item) => !seen.has(item.id));
	return [...older, ...tail];
}

export function CadmusProvider({
	children,
	clientOverride,
	initialConfig,
	sessionMode = false,
	skipTenantSync = false,
}: {
	children: ReactNode;
	clientOverride?: CadmusClient;
	initialConfig?: Partial<DevAuthConfig>;
	/** A Cadmus session is active: keep its access token fresh. */
	sessionMode?: boolean;
	/** True for non-workspace personas (super-admin & account-admin). */
	skipTenantSync?: boolean;
}) {
	setStorageScope(sessionMode ? initialConfig?.accountId : undefined);
	const [authConfig] = useState<DevAuthConfig>(() => ({
		userId: initialConfig?.userId ?? "",
		accountId: initialConfig?.accountId ?? "",
		familyId: initialConfig?.familyId?.trim() || loadStoredFamilyId(),
		token: initialConfig?.token ?? "",
	}));
	const client = useMemo(() => {
		if (clientOverride) return clientOverride;
		return new CadmusClient({
			baseUrl: "",
			userId: authConfig.userId,
			accountId: sessionMode ? selectedAccountId() : authConfig.accountId,
			familyId: authConfig.familyId,
			token: authConfig.token,
			useTickets: sessionMode,
		});
	}, [authConfig, clientOverride, sessionMode]);

	useEffect(() => {
		if (!sessionMode || clientOverride) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let stopped = false;
		const schedule = (expiresAt: number) => {
			const wait = Math.max(5_000, expiresAt - Date.now() - REFRESH_MARGIN_MS);
			timer = setTimeout(async () => {
				const next = await refreshSession();
				if (stopped) return;
				if (next) {
					client.setToken(next.accessToken, { reconnect: false });
					schedule(next.expiresAt);
				} else {
					schedule(Date.now() + REFRESH_MARGIN_MS + REFRESH_RETRY_MS);
				}
			}, wait);
		};
		schedule(Date.now() + 15 * 60_000);
		const unsubscribe = onSessionTokens((tokens) => {
			client.setToken(tokens.accessToken, { reconnect: false });
		});
		const unsubscribeEnded = onSessionEnded(() => {
			window.location.assign("/login");
		});
		return () => {
			unsubscribe();
			unsubscribeEnded();
			stopped = true;
			if (timer) clearTimeout(timer);
		};
	}, [sessionMode, clientOverride, client]);

	const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(
		client.getStatus(),
	);
	const [bots, setBots] = useState<BotRecord[]>([]);
	const [chats, setChats] = useState<ChatRecord[]>([]);
	const [families, setFamilies] = useState<FamilyRecord[]>([]);
	const [compactingChats, setCompactingChats] = useState<
		Record<string, boolean>
	>({});
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
		`${client.getAccountId()}:${authConfig.familyId}`,
	);
	const directoryDetailRef = useRef(false);

	const [activeChat, setActiveChat] =
		useState<ActiveChatState>(EMPTY_ACTIVE_CHAT);
	const activeChatKeyRef = useRef<string | null>(null);
	activeChatKeyRef.current = activeChat.chatKey;

	const setActiveChatTranscript = useCallback(
		(
			chatKey: string,
			messages: TranscriptMessageView[],
			tasks?: ChatTask[],
		) => {
			setActiveChat((prev) => ({
				...prev,
				chatKey,
				messages,
				tasks: tasks ?? (prev.chatKey === chatKey ? prev.tasks : []),
			}));
		},
		[],
	);

	const setActiveChatTasks = useCallback(
		(chatKey: string, tasks: ChatTask[]) => {
			setActiveChat((prev) => {
				if (prev.chatKey !== chatKey) return prev;
				return { ...prev, tasks };
			});
		},
		[],
	);

	const clearActiveChat = useCallback((chatKey?: string) => {
		setActiveChat((prev) => {
			if (chatKey && prev.chatKey !== chatKey) return prev;
			return EMPTY_ACTIVE_CHAT;
		});
	}, []);

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
				setCompactingChats((prev) => ({
					...prev,
					[chatKey]: Boolean(reported.compaction?.active),
				}));
			}
		},
		[bumpStatusEpoch, client, patchState],
	);

	const loadBotChat = useCallback(
		async (chatKey: string) => {
			const [res] = await Promise.all([
				client.callRpc<ChatGetResponse>("chat.get", {
					chatKey,
					raw: true,
					limit: CHAT_PAGE_LIMIT,
				}),
				refreshChatStatus(chatKey),
			]);
			if (!res.ok || !res.result) return;
			const data = res.result;
			setActiveChat({
				chatKey,
				messages: data.messages ?? [],
				entries: data.entries ?? [],
				tasks: data.tasks ?? [],
				notes: data.notes ?? [],
				taskLoop: data.taskLoop,
				hasMore: Boolean(data.hasMore),
				oldestEntryId: data.oldestEntryId,
				loadingOlder: false,
			});
			setCompactingChats((prev) => ({
				...prev,
				[chatKey]: Boolean(data.compacting),
			}));
			const lastAssistant = (data.messages ?? []).findLast(
				(m) => m.role === "assistant" && m.text.trim(),
			);
			if (lastAssistant) {
				patchState(chatKey, {
					lastBotText: lastAssistant.text,
					...(lastAssistant.timestamp
						? { lastBotAt: lastAssistant.timestamp }
						: {}),
				});
			}
		},
		[client, patchState, refreshChatStatus],
	);

	const loadOlderMessages = useCallback(
		async (chatKey: string) => {
			let beforeId: number | undefined;
			let canLoad = false;
			setActiveChat((prev) => {
				if (prev.chatKey !== chatKey || prev.loadingOlder || !prev.hasMore) {
					return prev;
				}
				beforeId = prev.oldestEntryId;
				canLoad = beforeId !== undefined;
				return canLoad ? { ...prev, loadingOlder: true } : prev;
			});
			if (!canLoad || beforeId === undefined) return;
			const res = await client.callRpc<ChatGetResponse>("chat.get", {
				chatKey,
				raw: true,
				limit: CHAT_PAGE_LIMIT,
				beforeEntryId: beforeId,
			});
			setActiveChat((prev) => {
				if (prev.chatKey !== chatKey) return prev;
				if (!res.ok || !res.result) {
					return { ...prev, loadingOlder: false };
				}
				const olderMessages = res.result.messages ?? [];
				const olderEntries = res.result.entries ?? [];
				return {
					...prev,
					messages: dedupeById(olderMessages, prev.messages),
					entries: dedupeById(olderEntries, prev.entries),
					hasMore: Boolean(res.result.hasMore),
					oldestEntryId: res.result.oldestEntryId ?? prev.oldestEntryId,
					loadingOlder: false,
				};
			});
		},
		[client],
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
		setCompactingChats({});
		setTeamLeaderBotId(undefined);
		setActiveChat(EMPTY_ACTIVE_CHAT);
	}, []);

	const refreshDirectory = useCallback(async () => {
		const scope = `${client.getAccountId()}:${client.getFamilyId()}`;
		if (directoryScopeRef.current !== scope) {
			clearDirectory(scope);
		}
		const keep = directoryDetailRef.current;
		try {
			const [botRes, chatRes, familyRes, familiesRes] = await Promise.all([
				client.callRpc<{ bots: BotRecord[] }>("bot.list"),
				client.callRpc<{ chats: ChatRecord[] }>("chat.list", {
					kinds: ["direct"],
				}),
				client.callRpc<{ family?: FamilyRecord }>("family.get"),
				client.callRpc<{ families?: FamilyRecord[] }>("family.list"),
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
			if (familiesRes.ok && familiesRes.result?.families) {
				setFamilies(familiesRes.result.families);
			}
			setBots(botRes.result?.bots ?? []);
			const listed = chatRes.result?.chats ?? [];
			setChats(listed);
			setDirectoryReady(true);
			setDirectoryError(undefined);
			await Promise.all(
				listed.map(async (chat) => {
					try {
						const [, detail] = await Promise.all([
							refreshChatStatus(chat.key),
							client.callRpc<{
								compacting?: boolean;
								messages?: Array<{
									role: string;
									text: string;
									timestamp?: number;
								}>;
							}>("chat.get", { chatKey: chat.key, limit: 20 }),
						]);
						if (!detail.ok) return;
						if (detail.result?.compacting !== undefined) {
							setCompactingChats((prev) => ({
								...prev,
								[chat.key]: Boolean(detail.result?.compacting),
							}));
						}
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
		if (skipTenantSync) {
			client.close();
			setBots([]);
			setChats([]);
			setFamilies([]);
			setCompactingChats({});
			setDirectoryReady(true);
			setDirectoryDetailReady(true);
			setDirectoryError(undefined);
			return;
		}
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
	}, [client, deliverTurn, refreshDirectory, skipTenantSync]);

	useEffect(() => {
		return client.subscribe((event: ServerEvent) => {
			if (event.type === "chat.state") {
				bumpStatusEpoch(event.payload.chatKey);
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
							activeTool: busy ? current?.activeTool : undefined,
							status: current?.status
								? { ...current.status, busy }
								: current?.status,
						},
					};
				});
				return;
			}
			if (event.type === "chat.compaction") {
				const { chatKey, phase } = event.payload;
				const active = phase === "started";
				setCompactingChats((prev) => ({ ...prev, [chatKey]: active }));
				if (!active) {
					void refreshChatStatus(chatKey);
					if (activeChatKeyRef.current === chatKey) {
						void loadBotChat(chatKey);
					}
				}
				return;
			}
			if (event.type === "turn.delta") {
				bumpStatusEpoch(event.payload.chatKey);
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
				bumpStatusEpoch(event.payload.chatKey);
				if (holdIdle.current.has(event.payload.chatKey)) return;
				setChatStates((prev) => {
					const current = prev[event.payload.chatKey];
					return {
						...prev,
						[event.payload.chatKey]: {
							...current,
							busy: true,
							lastToolName: event.payload.toolName,
							activeTool: {
								toolCallId: event.payload.toolCallId,
								toolName: event.payload.toolName,
								args: event.payload.args,
								startedAt: Date.now(),
							},
							status: current?.status
								? { ...current.status, busy: true }
								: current?.status,
						},
					};
				});
				return;
			}
			if (event.type === "turn.tool_result") {
				if (holdIdle.current.has(event.payload.chatKey)) return;
				setChatStates((prev) => {
					const current = prev[event.payload.chatKey];
					if (!current) return prev;
					const matchedActive =
						current.activeTool?.toolCallId === event.payload.toolCallId
							? current.activeTool
							: undefined;
					const activeTool = matchedActive ? undefined : current.activeTool;
					const completedTool = {
						id: event.payload.toolCallId,
						name: event.payload.toolName ?? matchedActive?.toolName ?? "tool",
						args: matchedActive?.args,
						isError: event.payload.isError,
						durationMs: matchedActive
							? Date.now() - matchedActive.startedAt
							: undefined,
						result: { isError: event.payload.isError },
					};
					const existing = current.liveTools ?? [];
					const liveTools = existing.some((t) => t.id === completedTool.id)
						? existing
						: [...existing, completedTool];
					return {
						...prev,
						[event.payload.chatKey]: {
							...current,
							activeTool,
							liveTools,
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
						activeTool: undefined,
						liveTools: undefined,
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
				if (activeChatKeyRef.current === event.payload.chatKey) {
					void loadBotChat(event.payload.chatKey);
				}
				void refreshDirectory();
				return;
			}
			if (event.type === "bot.message") {
				patchState(event.payload.chatKey, {
					lastBotText: event.payload.reply ?? event.payload.text,
					lastBotAt: event.payload.when,
				});
				return;
			}
			if (event.type === "account.toolsEnv.event") {
				setChatStates((prev) => {
					let changed = false;
					const next: Record<string, ChatLiveState> = {};
					for (const [chatKey, state] of Object.entries(prev)) {
						const env = state.status?.toolsEnv;
						if (state.status && env && env.envId === event.payload.envId) {
							changed = true;
							next[chatKey] = {
								...state,
								status: {
									...state.status,
									toolsEnv: {
										...env,
										status: event.payload.status,
										...(event.payload.connectedAt !== undefined
											? { connectedAt: event.payload.connectedAt }
											: {}),
										lastError: event.payload.lastError ?? undefined,
									},
								},
							};
						} else {
							next[chatKey] = state;
						}
					}
					return changed ? next : prev;
				});
			}
		});
	}, [
		bumpStatusEpoch,
		client,
		loadBotChat,
		patchState,
		persistFailed,
		refreshChatStatus,
		refreshDirectory,
	]);

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
				localStorage.setItem(
					STORAGE_KEY,
					JSON.stringify({ familyId: trimmed }),
				);
			} catch {
				/* private mode */
			}
			client.setFamilyId(trimmed);
			setFamilyId(trimmed);
			clearDirectory(`${client.getAccountId()}:${trimmed}`);
			await refreshDirectory();
		},
		[clearDirectory, client, refreshDirectory],
	);

	const createFamily = useCallback(
		async (input: CreateFamilyInput): Promise<FamilyRecord | null> => {
			const res = await client.callRpc<{ family: FamilyRecord }>(
				"family.create",
				input as unknown as Record<string, unknown>,
			);
			if (!res.ok || !res.result?.family) return null;
			await refreshDirectory();
			return res.result.family;
		},
		[client, refreshDirectory],
	);

	const updateFamily = useCallback(
		async (
			targetFamilyId: string,
			patch: {
				name?: string;
				timezone?: string;
				teamLeaderBotId?: string | null;
			},
		): Promise<boolean> => {
			const res = await client.callRpc("family.update", {
				familyId: targetFamilyId,
				...patch,
			});
			if (!res.ok) return false;
			await refreshDirectory();
			return true;
		},
		[client, refreshDirectory],
	);

	const deleteFamily = useCallback(
		async (targetFamilyId: string): Promise<boolean> => {
			const res = await client.callRpc("family.delete", {
				familyId: targetFamilyId,
			});
			if (!res.ok) return false;
			if (targetFamilyId === familyId) {
				await switchFamily(DEFAULT_FAMILY_ID);
			} else {
				await refreshDirectory();
			}
			return true;
		},
		[client, familyId, refreshDirectory, switchFamily],
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
			families,
			chatStates,
			compactingChats,
			lastSeen,
			collapsed,
			lastBotId,
			teamLeaderBotId,
			familyId,
			switchFamily,
			createFamily,
			updateFamily,
			deleteFamily,
			directoryReady,
			directoryDetailReady,
			directoryError,
			skipTenantSync,
			refreshDirectory,
			subscribeEvents: (listener) => client.subscribe(listener),
			toggleCollapsed,
			markChatSeen,
			setLastBotId,
			retryChat,
			noteUserText,
			markFailed,
			queueTurn,
			refreshChatStatus,
			loadBotChat,
			loadOlderMessages,
			activeChat,
			setActiveChatTranscript,
			setActiveChatTasks,
			clearActiveChat,
		}),
		[
			authConfig,
			bots,
			chatStates,
			chats,
			families,
			compactingChats,
			client,
			collapsed,
			connectionStatus,
			familyId,
			lastBotId,
			switchFamily,
			createFamily,
			updateFamily,
			deleteFamily,
			teamLeaderBotId,
			directoryReady,
			directoryDetailReady,
			directoryError,
			skipTenantSync,
			lastSeen,
			markChatSeen,
			markFailed,
			noteUserText,
			refreshDirectory,
			queueTurn,
			refreshChatStatus,
			loadBotChat,
			loadOlderMessages,
			retryChat,
			setLastBotId,
			toggleCollapsed,
			activeChat,
			setActiveChatTranscript,
			setActiveChatTasks,
			clearActiveChat,
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
