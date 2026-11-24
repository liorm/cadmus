import {
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	useNavigate,
	useRouterState,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { AccountResetNotice } from "@/components/AccountResetNotice";
import { CadmusProvider } from "@/context/CadmusContext";
import { ElevationProvider } from "@/context/ElevationContext";
import { useSession } from "@/context/SessionContext";
import {
	defaultRouteForRole,
	isRouteAllowedForRole,
} from "@/lib/persona-routing";
import { AdminAuditPage } from "@/surfaces/account-admin/AdminAuditPage";
import { AdminMembersPage } from "@/surfaces/account-admin/AdminMembersPage";
import { AdminOverviewPage } from "@/surfaces/account-admin/AdminOverviewPage";
import { AdminProvidersPage } from "@/surfaces/account-admin/AdminProvidersPage";
import { SystemAuditPage } from "@/surfaces/super-admin/SystemAuditPage";
import { SystemMetricsPage } from "@/surfaces/super-admin/SystemMetricsPage";
import { SystemTenantDetailPage } from "@/surfaces/super-admin/SystemTenantDetailPage";
import { SystemTenantsPage } from "@/surfaces/super-admin/SystemTenantsPage";
import { BotStreamPage } from "@/surfaces/user/BotStreamPage";
import { BotsHomePage } from "@/surfaces/user/BotsHomePage";
import { BotsSidebarPanel } from "@/surfaces/user/BotsSidebarPanel";
import { EnvsPage } from "@/surfaces/user/EnvsPage";
import { SchedulesPage } from "@/surfaces/user/SchedulesPage";
import { SearchPage } from "@/surfaces/user/SearchPage";
import { SkillsPage } from "@/surfaces/user/SkillsPage";
import { UserShell } from "@/surfaces/user/UserShell";

function PersonaRouteGuard() {
	const session = useSession();
	const navigate = useNavigate();
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});

	useEffect(() => {
		if (!session.principal) return;
		const role = session.principal.role;
		if (
			pathname === "/" ||
			pathname === "/app" ||
			!isRouteAllowedForRole(pathname, role)
		) {
			void navigate({
				to: defaultRouteForRole(role),
				replace: true,
			});
		}
	}, [navigate, pathname, session.principal]);

	if (!session.principal) {
		return (
			<div className="flex h-[100dvh] w-full items-center justify-center bg-bg text-xs text-text-muted">
				Loading session…
			</div>
		);
	}

	return <Outlet />;
}

function RootComponent() {
	const session = useSession();
	if (!session.signedIn || !session.tokens || session.principal?.provisional) {
		return null;
	}
	return (
		<CadmusProvider
			key="signed-in"
			sessionMode
			skipTenantSync={session.principal?.role !== "user"}
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
				<PersonaRouteGuard />
			</ElevationProvider>
		</CadmusProvider>
	);
}

const rootRoute = createRootRoute({
	component: RootComponent,
});

const indexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	component: function RoleIndexPage() {
		return null;
	},
});

// ---------------------------------------------------------------------------
// User surface
// ---------------------------------------------------------------------------
const botsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/bots",
	component: BotsHomePage,
});

const botRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/bot/$botId",
	component: function BotDetailRoutePage() {
		const { botId } = botRoute.useParams();
		return (
			<UserShell
				activeTab="bots"
				hideMobileChrome
				sidepanel={<BotsSidebarPanel activeBotId={botId} />}
			>
				<BotStreamPage botId={botId} />
			</UserShell>
		);
	},
});

const schedulesRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/schedules",
	component: SchedulesPage,
});

const envsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/envs",
	component: EnvsPage,
});

const skillsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/skills",
	component: SkillsPage,
});

const searchRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/search",
	component: SearchPage,
});

// ---------------------------------------------------------------------------
// Account-Admin surface
// ---------------------------------------------------------------------------
const adminRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/admin",
	component: AdminOverviewPage,
});

const adminMembersRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/admin/members",
	component: AdminMembersPage,
});

const adminProvidersRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/admin/providers",
	component: AdminProvidersPage,
});

const adminAuditRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/admin/audit",
	component: AdminAuditPage,
});

// ---------------------------------------------------------------------------
// Super-Admin surface
// ---------------------------------------------------------------------------
const systemRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/system",
	component: SystemMetricsPage,
});

const systemTenantsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/system/tenants",
	component: SystemTenantsPage,
});

const systemTenantDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/system/tenants/$accountId",
	component: function SystemTenantDetailRoutePage() {
		const { accountId } = systemTenantDetailRoute.useParams();
		return <SystemTenantDetailPage accountId={accountId} />;
	},
});

const systemAuditRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/system/audit",
	component: SystemAuditPage,
});

const routeTree = rootRoute.addChildren([
	indexRoute,
	botsRoute,
	botRoute,
	schedulesRoute,
	envsRoute,
	skillsRoute,
	searchRoute,
	adminRoute,
	adminMembersRoute,
	adminProvidersRoute,
	adminAuditRoute,
	systemRoute,
	systemTenantsRoute,
	systemTenantDetailRoute,
	systemAuditRoute,
]);

export const router = createRouter({
	routeTree,
	basepath: "/app",
	defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}
