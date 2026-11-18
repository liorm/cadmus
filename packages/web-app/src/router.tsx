import {
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
} from "@tanstack/react-router";
import { AccountResetNotice } from "@/components/AccountResetNotice";
import { DesktopCockpitShell } from "@/components/desktop/CommandCockpit";
import { CommandPaletteHost } from "@/components/desktop/CommandPalette";
import { useDesktopViewport } from "@/components/desktop/use-desktop-viewport";
import { LoginDialog } from "@/components/LoginDialog";
import { CadmusProvider } from "@/context/CadmusContext";
import { ElevationProvider } from "@/context/ElevationContext";
import { SessionBoot } from "@/context/SessionContext";
import { isBotTab } from "@/lib/profile-tabs";
import { ArchivePage } from "@/routes/archive";
import { NewBotPage } from "@/routes/bot-new";
import { ChatPage } from "@/routes/chat";
import { ChatStatusPage } from "@/routes/chat-status";
import { DocPage } from "@/routes/doc";
import { HarvestPage } from "@/routes/harvest";
import { HomePage } from "@/routes/home";
import { NewTaskPage } from "@/routes/new";
import { ProfilePage } from "@/routes/profile";
import { SchedulePage } from "@/routes/schedule";
import { SearchPage } from "@/routes/search";
import { SettingsPage } from "@/routes/settings";
import { AccountSettingsPage } from "@/routes/settings-account";
import { FamilySettingsPage } from "@/routes/settings-family";
import { ProvidersSettingsPage } from "@/routes/settings-providers";
import { AllSchedulesPage } from "@/routes/settings-schedules";
import { SecuritySettingsPage } from "@/routes/settings-security";
import { TokensSettingsPage } from "@/routes/settings-tokens";
import { ToolsSettingsPage } from "@/routes/settings-tools";
import { SystemConsolePage } from "@/routes/system";
import { ToolsPage } from "@/routes/tools";

function RootComponent() {
	const desktop = useDesktopViewport();
	return (
		<SessionBoot>
			{(session) =>
				session.signedIn && session.tokens ? (
					<CadmusProvider
						key="signed-in"
						sessionMode
						skipTenantSync={
							session.principal?.role === "super-admin" ||
							(!session.principal && session.tokens.accountId === "system")
						}
						initialConfig={{
							token: session.tokens.accessToken,
							accountId:
								session.principal?.accountId ?? session.tokens.accountId ?? "",
							userId: session.principal?.userId ?? session.tokens.userId ?? "",
						}}
					>
						<ElevationProvider>
							{session.notice ? (
								<AccountResetNotice message={session.notice} />
							) : null}
							<CommandPaletteHost />
							{desktop ? (
								<DesktopCockpitShell>
									<Outlet />
								</DesktopCockpitShell>
							) : (
								<Outlet />
							)}
						</ElevationProvider>
					</CadmusProvider>
				) : (
					<LoginDialog providers={session.providers} />
				)
			}
		</SessionBoot>
	);
}

const rootRoute = createRootRoute({
	component: RootComponent,
});

const indexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	component: HomePage,
});

const chatRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/chat/$chatKey",
	validateSearch: (
		search: Record<string, unknown>,
	): { view: "chat" | "raw" } => ({
		view: search.view === "raw" ? "raw" : "chat",
	}),
	component: function ChatRoutePage() {
		const { view } = chatRoute.useSearch();
		return <ChatPage view={view} />;
	},
});

const chatStatusRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/chat/$chatKey/status",
	component: ChatStatusPage,
});

const newTaskRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/new",
	validateSearch: (search: Record<string, unknown>): { bot?: string } => ({
		bot: typeof search.bot === "string" ? search.bot : undefined,
	}),
	component: function NewTaskRoutePage() {
		const { bot } = newTaskRoute.useSearch();
		return <NewTaskPage key={bot} botId={bot} />;
	},
});

const newBotRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/bot/new",
	component: NewBotPage,
});

const botRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/bot/$botId",
	component: function BotDefaultRoutePage() {
		const { botId } = botRoute.useParams();
		return <ProfilePage botId={botId} tab="schedules" />;
	},
});

const botTabRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/bot/$botId/$tab",
	component: function BotTabPage() {
		const { botId, tab } = botTabRoute.useParams();
		return (
			<ProfilePage botId={botId} tab={isBotTab(tab) ? tab : "schedules"} />
		);
	},
});

const scheduleRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/bot/$botId/schedule/$id",
	validateSearch: (search: Record<string, unknown>): { from?: "all" } => ({
		from: search.from === "all" ? "all" : undefined,
	}),
	component: function ScheduleRoutePage() {
		const { botId, id } = scheduleRoute.useParams();
		const { from } = scheduleRoute.useSearch();
		return <SchedulePage botId={botId} id={id} from={from} />;
	},
});

const toolsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/bot/$botId/tools",
	component: function ToolsRoutePage() {
		const { botId } = toolsRoute.useParams();
		return <ToolsPage botId={botId} />;
	},
});

const harvestRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/bot/$botId/harvest",
	component: function HarvestRoutePage() {
		const { botId } = harvestRoute.useParams();
		return <HarvestPage botId={botId} />;
	},
});

const docRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/bot/$botId/doc",
	validateSearch: (search: Record<string, unknown>): { path: string } => ({
		path: typeof search.path === "string" ? search.path : "MEMORY.md",
	}),
	component: function DocRoutePage() {
		const { botId } = docRoute.useParams();
		const { path } = docRoute.useSearch();
		return <DocPage botId={botId} path={path} />;
	},
});

const systemRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/system",
	component: SystemConsolePage,
});

const settingsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/settings",
	component: SettingsPage,
});

const accountSettingsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/settings/account",
	component: AccountSettingsPage,
});

const securitySettingsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/settings/security",
	component: SecuritySettingsPage,
});

const tokensSettingsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/settings/tokens",
	component: TokensSettingsPage,
});

const familySettingsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/settings/family",
	component: FamilySettingsPage,
});

const providersSettingsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/settings/providers",
	component: ProvidersSettingsPage,
});

const toolsSettingsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/settings/tools",
	component: ToolsSettingsPage,
});

const allSchedulesRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/settings/schedules",
	component: AllSchedulesPage,
});

const archiveRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/settings/archive",
	component: ArchivePage,
});

const searchRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/search",
	component: SearchPage,
});

const routeTree = rootRoute.addChildren([
	indexRoute,
	chatRoute,
	chatStatusRoute,
	newTaskRoute,
	newBotRoute,
	botRoute,
	botTabRoute,
	scheduleRoute,
	toolsRoute,
	harvestRoute,
	docRoute,
	settingsRoute,
	systemRoute,
	securitySettingsRoute,
	tokensSettingsRoute,
	accountSettingsRoute,
	familySettingsRoute,
	providersSettingsRoute,
	toolsSettingsRoute,
	allSchedulesRoute,
	archiveRoute,
	searchRoute,
]);

export const router = createRouter({
	routeTree,
	defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}
