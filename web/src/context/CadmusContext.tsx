import type { ReactNode } from "react";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import type {
	BotRecord,
	FamilyRecord,
	ModelInfo,
	ServerEvent,
} from "../../../src/protocol.js";
import { CadmusClient, type ConnectionStatus } from "../client.js";

export type ActiveTab = "chat" | "bots" | "schedules";

export interface DevAuthConfig {
	userId: string;
	accountId: string;
	familyId: string;
	token: string;
}

export interface CadmusContextValue {
	client: CadmusClient;
	authConfig: DevAuthConfig;
	connectionStatus: ConnectionStatus;
	families: FamilyRecord[];
	currentFamily: FamilyRecord | null;
	bots: BotRecord[];
	selectedBotId: string | null;
	selectedBot: BotRecord | null;
	models: ModelInfo[];
	activeTab: ActiveTab;
	isLoading: boolean;
	lastError: string | null;
	refreshFamilies: () => Promise<void>;
	refreshBots: () => Promise<void>;
	refreshModels: () => Promise<void>;
	selectFamily: (familyId: string) => Promise<void>;
	selectBot: (botId: string) => void;
	updateAuthConfig: (partial: Partial<DevAuthConfig>) => Promise<void>;
	subscribeEvents: (listener: (event: ServerEvent) => void) => () => void;
	setActiveTab: (tab: ActiveTab) => void;
	isCredentialsOpen: boolean;
	credentialsInitialProvider?: string;
	openCredentials: (providerId?: string) => void;
	closeCredentials: () => void;
}

const STORAGE_KEY = "cadmus.dev.config";

const DEFAULT_AUTH_CONFIG: DevAuthConfig = {
	userId: "dev",
	accountId: "default-account",
	familyId: "default",
	token: "dev-cadmus-secret",
};

function loadStoredConfig(): DevAuthConfig {
	if (typeof window === "undefined") {
		return DEFAULT_AUTH_CONFIG;
	}
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw) as Partial<DevAuthConfig>;
			return {
				userId: parsed.userId?.trim() || DEFAULT_AUTH_CONFIG.userId,
				accountId: parsed.accountId?.trim() || DEFAULT_AUTH_CONFIG.accountId,
				familyId: parsed.familyId?.trim() || DEFAULT_AUTH_CONFIG.familyId,
				token: parsed.token?.trim() || DEFAULT_AUTH_CONFIG.token,
			};
		}
	} catch {
		// Ignore storage read errors
	}
	return DEFAULT_AUTH_CONFIG;
}

function persistConfig(config: DevAuthConfig): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
	} catch {
		// Ignore storage write errors
	}
}

const CadmusContext = createContext<CadmusContextValue | null>(null);

export interface CadmusProviderProps {
	children: ReactNode;
	initialConfig?: Partial<DevAuthConfig>;
	clientOverride?: CadmusClient;
	initialActiveTab?: ActiveTab;
}

export function CadmusProvider({
	children,
	initialConfig,
	clientOverride,
	initialActiveTab,
}: CadmusProviderProps) {
	const [authConfig, setAuthConfig] = useState<DevAuthConfig>(() => {
		const stored = loadStoredConfig();
		return {
			...stored,
			...initialConfig,
		};
	});

	const client = useMemo(() => {
		if (clientOverride) return clientOverride;
		return new CadmusClient({
			baseUrl: "",
			userId: authConfig.userId,
			accountId: authConfig.accountId,
			familyId: authConfig.familyId,
			token: authConfig.token,
		});
	}, [
		clientOverride,
		authConfig.userId,
		authConfig.accountId,
		authConfig.familyId,
		authConfig.token,
	]);

	const [connectionStatus, setConnectionStatus] =
		useState<ConnectionStatus>("disconnected");
	const [families, setFamilies] = useState<FamilyRecord[]>([]);
	const [currentFamily, setCurrentFamily] = useState<FamilyRecord | null>(null);
	const [bots, setBots] = useState<BotRecord[]>([]);
	const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
	const [models, setModels] = useState<ModelInfo[]>([]);
	const [activeTab, setActiveTab] = useState<ActiveTab>(
		initialActiveTab ?? "chat",
	);
	const [isLoading, setIsLoading] = useState<boolean>(true);
	const [lastError, setLastError] = useState<string | null>(null);
	const [isCredentialsOpen, setIsCredentialsOpen] = useState(false);
	const [credentialsInitialProvider, setCredentialsInitialProvider] = useState<
		string | undefined
	>(undefined);

	const openCredentials = useCallback((providerId?: string) => {
		setCredentialsInitialProvider(providerId);
		setIsCredentialsOpen(true);
	}, []);

	const closeCredentials = useCallback(() => {
		setIsCredentialsOpen(false);
		setCredentialsInitialProvider(undefined);
	}, []);

	const selectedBot = useMemo(() => {
		if (!selectedBotId) return null;
		return bots.find((b) => b.id === selectedBotId) ?? null;
	}, [bots, selectedBotId]);

	const refreshFamilies = useCallback(async () => {
		try {
			const listRes = await client.callRpc("family.list");
			if (listRes.ok && listRes.result?.families) {
				setFamilies(listRes.result.families);
			}

			const getRes = await client.callRpc("family.get", {
				familyId: client.getFamilyId(),
			});
			if (getRes.ok && getRes.result?.family) {
				setCurrentFamily(getRes.result.family);
			}
		} catch (err) {
			setLastError(
				err instanceof Error ? err.message : "Failed to load families",
			);
		}
	}, [client]);

	const refreshBots = useCallback(async () => {
		try {
			const res = await client.callRpc("bot.list");
			if (res.ok && res.result?.bots) {
				const botList = res.result.bots;
				setBots(botList);
				setSelectedBotId((prev) => {
					if (prev && botList.some((b) => b.id === prev)) {
						return prev;
					}
					return botList[0]?.id ?? null;
				});
			}
		} catch (err) {
			setLastError(err instanceof Error ? err.message : "Failed to load bots");
		}
	}, [client]);

	const refreshModels = useCallback(async () => {
		try {
			const res = await client.callRpc("account.models.list");
			if (res.ok && res.result?.models) {
				setModels(res.result.models);
			}
		} catch (err) {
			setLastError(
				err instanceof Error ? err.message : "Failed to load models",
			);
		}
	}, [client]);

	const selectFamily = useCallback(
		async (familyId: string) => {
			setAuthConfig((prev) => {
				const next = { ...prev, familyId };
				persistConfig(next);
				return next;
			});
			client.setFamilyId(familyId);
			setIsLoading(true);
			try {
				const getRes = await client.callRpc("family.get", { familyId });
				if (getRes.ok && getRes.result?.family) {
					setCurrentFamily(getRes.result.family);
				}
				await refreshBots();
			} finally {
				setIsLoading(false);
			}
		},
		[client, refreshBots],
	);

	const selectBot = useCallback((botId: string) => {
		setSelectedBotId(botId);
	}, []);

	const updateAuthConfig = useCallback(
		async (partial: Partial<DevAuthConfig>) => {
			const next = { ...authConfig, ...partial };
			persistConfig(next);
			setAuthConfig(next);
			client.updateConfig(next);
			setIsLoading(true);
			try {
				await Promise.all([refreshFamilies(), refreshBots(), refreshModels()]);
			} finally {
				setIsLoading(false);
			}
		},
		[authConfig, client, refreshFamilies, refreshBots, refreshModels],
	);

	const subscribeEvents = useCallback(
		(listener: (event: ServerEvent) => void) => {
			return client.subscribe(listener);
		},
		[client],
	);

	// Connect WebSocket and initialize state
	useEffect(() => {
		const unsubStatus = client.onStatusChange((status) => {
			setConnectionStatus(status);
		});

		client.connectWebSocket();

		let mounted = true;
		setIsLoading(true);

		Promise.all([refreshFamilies(), refreshBots(), refreshModels()]).finally(
			() => {
				if (mounted) {
					setIsLoading(false);
				}
			},
		);

		return () => {
			mounted = false;
			unsubStatus();
			client.close();
		};
	}, [client, refreshFamilies, refreshBots, refreshModels]);

	const contextValue: CadmusContextValue = useMemo(
		() => ({
			client,
			authConfig,
			connectionStatus,
			families,
			currentFamily,
			bots,
			selectedBotId,
			selectedBot,
			models,
			activeTab,
			isLoading,
			lastError,
			refreshFamilies,
			refreshBots,
			refreshModels,
			selectFamily,
			selectBot,
			updateAuthConfig,
			subscribeEvents,
			setActiveTab,
			isCredentialsOpen,
			credentialsInitialProvider,
			openCredentials,
			closeCredentials,
		}),
		[
			client,
			authConfig,
			connectionStatus,
			families,
			currentFamily,
			bots,
			selectedBotId,
			selectedBot,
			models,
			activeTab,
			isLoading,
			lastError,
			refreshFamilies,
			refreshBots,
			refreshModels,
			selectFamily,
			selectBot,
			updateAuthConfig,
			subscribeEvents,
			isCredentialsOpen,
			credentialsInitialProvider,
			openCredentials,
			closeCredentials,
		],
	);

	return (
		<CadmusContext.Provider value={contextValue}>
			{children}
		</CadmusContext.Provider>
	);
}

export function useCadmus(): CadmusContextValue {
	const context = useContext(CadmusContext);
	if (!context) {
		throw new Error("useCadmus must be used within a CadmusProvider");
	}
	return context;
}
