import { CadmusClient, type ConnectionStatus } from "@cadmus/contract/client";
import type {
	BotRecord,
	ChatRecord,
	ServerEvent,
} from "@cadmus/contract/types";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";

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

export interface CadmusContextValue {
	client: CadmusClient;
	authConfig: DevAuthConfig;
	connectionStatus: ConnectionStatus;
	bots: BotRecord[];
	chats: ChatRecord[];
	refreshDirectory: () => Promise<void>;
	subscribeEvents: (listener: (event: ServerEvent) => void) => () => void;
}

const CadmusContext = createContext<CadmusContextValue | null>(null);

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

	const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(
		client.getStatus(),
	);
	const [bots, setBots] = useState<BotRecord[]>([]);
	const [chats, setChats] = useState<ChatRecord[]>([]);

	const refreshDirectory = useCallback(async () => {
		const [botRes, chatRes] = await Promise.all([
			client.callRpc<{ bots: BotRecord[] }>("bot.list"),
			client.callRpc<{ chats: ChatRecord[] }>("chat.list"),
		]);
		if (botRes.ok && botRes.result?.bots) {
			setBots(botRes.result.bots);
		}
		if (chatRes.ok && chatRes.result?.chats) {
			setChats(chatRes.result.chats);
		}
	}, [client]);

	useEffect(() => {
		const off = client.onStatusChange(setConnectionStatus);
		client.connectWebSocket();
		void refreshDirectory();
		return () => {
			off();
			client.close();
		};
	}, [client, refreshDirectory]);

	const value = useMemo<CadmusContextValue>(
		() => ({
			client,
			authConfig,
			connectionStatus,
			bots,
			chats,
			refreshDirectory,
			subscribeEvents: (listener) => client.subscribe(listener),
		}),
		[authConfig, bots, chats, client, connectionStatus, refreshDirectory],
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
