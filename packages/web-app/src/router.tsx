import {
	createHashHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
} from "@tanstack/react-router";
import { CadmusProvider } from "@/context/CadmusContext";
import { isBotTab } from "@/lib/profile-tabs";
import { ChatPage } from "@/routes/chat";
import { DocPage } from "@/routes/doc";
import { HarvestPage } from "@/routes/harvest";
import { HomePage } from "@/routes/home";
import { NewTaskPage } from "@/routes/new";
import { PlaceholderPage } from "@/routes/placeholder";
import { ProfilePage } from "@/routes/profile";
import { SchedulePage } from "@/routes/schedule";
import { SearchPage } from "@/routes/search";
import { SettingsPage } from "@/routes/settings";
import { ToolsPage } from "@/routes/tools";

const rootRoute = createRootRoute({
	component: () => (
		<CadmusProvider>
			<Outlet />
		</CadmusProvider>
	),
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

const newTaskRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/new",
	validateSearch: (search: Record<string, unknown>): { bot?: string } => ({
		bot: typeof search.bot === "string" ? search.bot : undefined,
	}),
	component: function NewTaskRoutePage() {
		const { bot } = newTaskRoute.useSearch();
		return <NewTaskPage botId={bot} />;
	},
});

const newBotRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/bot/new",
	component: () => <PlaceholderPage title="New bot" />,
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
	component: function ScheduleRoutePage() {
		const { botId, id } = scheduleRoute.useParams();
		return <SchedulePage botId={botId} id={id} />;
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

const settingsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/settings",
	component: SettingsPage,
});

const archiveRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/settings/archive",
	component: () => <PlaceholderPage title="Archive" />,
});

const searchRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/search",
	component: SearchPage,
});

const routeTree = rootRoute.addChildren([
	indexRoute,
	chatRoute,
	newTaskRoute,
	newBotRoute,
	botRoute,
	botTabRoute,
	scheduleRoute,
	toolsRoute,
	harvestRoute,
	docRoute,
	settingsRoute,
	archiveRoute,
	searchRoute,
]);

const hashHistory = createHashHistory();

export const router = createRouter({
	routeTree,
	history: hashHistory,
	defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}
