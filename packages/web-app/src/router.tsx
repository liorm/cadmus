import {
	createHashHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
} from "@tanstack/react-router";
import { BotBadge } from "@/components/BotBadge";
import { Markdown } from "@/components/Markdown";
import { SegmentedControl } from "@/components/SegmentedControl";
import { CadmusProvider } from "@/context/CadmusContext";
import { HomePage } from "@/routes/home";
import { PlaceholderPage } from "@/routes/placeholder";
import { SettingsPage } from "@/routes/settings";

const BOT_TABS = [
	"schedules",
	"memory",
	"knowledge",
	"soul",
	"config",
] as const;

export type BotTab = (typeof BOT_TABS)[number];

function isBotTab(value: string): value is BotTab {
	return (BOT_TABS as readonly string[]).includes(value);
}

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
	component: function ChatPlaceholder() {
		const { chatKey } = chatRoute.useParams();
		const { view } = chatRoute.useSearch();
		return (
			<PlaceholderPage title={view === "raw" ? "Raw transcript" : "Chat"}>
				<p>chatKey: {chatKey}</p>
				<p>view: {view}</p>
			</PlaceholderPage>
		);
	},
});

const newTaskRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/new",
	validateSearch: (search: Record<string, unknown>): { bot?: string } => ({
		bot: typeof search.bot === "string" ? search.bot : undefined,
	}),
	component: function NewTaskPlaceholder() {
		const { bot } = newTaskRoute.useSearch();
		return (
			<PlaceholderPage title="New task">
				{bot ? <p>bot: {bot}</p> : null}
			</PlaceholderPage>
		);
	},
});

const newBotRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/bot/new",
	component: () => <PlaceholderPage title="New bot" />,
});

const botTabRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/bot/$botId/$tab",
	component: function BotTabPlaceholder() {
		const { botId, tab } = botTabRoute.useParams();
		const current = isBotTab(tab) ? tab : "schedules";
		return (
			<PlaceholderPage title={botId}>
				<BotBadge bot={{ id: botId, name: botId }} />
				<SegmentedControl
					scroll
					ariaLabel="Bot profile tabs"
					value={current}
					onValueChange={() => undefined}
					options={BOT_TABS.map((name) => ({
						value: name,
						label: name[0]?.toUpperCase() + name.slice(1),
					}))}
				/>
				{current === "memory" ? (
					<Markdown source="# Memory\nThis is **rendered** markdown." />
				) : null}
			</PlaceholderPage>
		);
	},
});

const scheduleRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/bot/$botId/schedule/$id",
	component: function SchedulePlaceholder() {
		const { botId, id } = scheduleRoute.useParams();
		return (
			<PlaceholderPage title="Schedule">
				<p>
					{botId} / {id}
				</p>
			</PlaceholderPage>
		);
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
	component: () => <PlaceholderPage title="Search" />,
});

const routeTree = rootRoute.addChildren([
	indexRoute,
	chatRoute,
	newTaskRoute,
	newBotRoute,
	botTabRoute,
	scheduleRoute,
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
