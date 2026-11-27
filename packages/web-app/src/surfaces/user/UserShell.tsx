import { Link } from "@tanstack/react-router";
import {
	Bot,
	CalendarClock,
	PanelLeftClose,
	PanelLeftOpen,
	Search,
	Sparkles,
	Terminal,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { IdentityChip } from "@/components/chrome/IdentityChip";
import { ReconnectBar } from "@/components/ReconnectBar";
import { cn } from "@/lib/utils";

export type UserTab = "bots" | "schedules" | "envs" | "skills";

const TABS: Array<{
	id: UserTab;
	label: string;
	to: "/bots" | "/schedules" | "/envs" | "/skills";
	icon: typeof Bot;
}> = [
	{ id: "bots", label: "Bots", to: "/bots", icon: Bot },
	{
		id: "schedules",
		label: "Schedules",
		to: "/schedules",
		icon: CalendarClock,
	},
	{ id: "envs", label: "Envs", to: "/envs", icon: Terminal },
	{ id: "skills", label: "Skills", to: "/skills", icon: Sparkles },
];

/**
 * Dual-surface User shell:
 * - Desktop (`md:`): single collapsible left sidepanel (`w-80` / `w-14`) with
 *   top `IdentityChip`, optional middle drawer content (`BotsSidebarPanel` on
 *   bot routes), and bottom 4 section tabs + Search. No duplicate top-right pill.
 * - Mobile (`< md`): compact top header + 4-tab bottom bar (hidden when inside
 *   an active `/bot/$botId` conversation stream).
 */
export function UserShell({
	activeTab,
	sidepanel,
	hideMobileChrome = false,
	mobileTitle,
	children,
}: {
	activeTab: UserTab | "search";
	sidepanel?: ReactNode;
	hideMobileChrome?: boolean;
	mobileTitle?: string;
	children?: ReactNode;
}) {
	const [collapsed, setCollapsed] = useState(false);

	return (
		<div className="flex h-[100dvh] w-full flex-col overflow-hidden bg-bg text-text md:flex-row">
			{/* Desktop Left Sidepanel (Single collapsible rail/sidebar) */}
			<aside
				aria-label="User workspace sidebar"
				className={cn(
					"hidden shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-150 md:flex",
					collapsed ? "w-14" : "w-[272px]",
				)}
			>
				<div className="flex items-center justify-between gap-2 border-b border-border px-2.5 py-2.5">
					{!collapsed ? (
						<div className="min-w-0 flex-1">
							<IdentityChip />
						</div>
					) : (
						<IdentityChip compact />
					)}
					{!collapsed ? (
						<Link
							to="/search"
							aria-label="Search workspace"
							className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border text-text-muted hover:bg-surface-raised hover:text-text"
						>
							<Search className="h-3.5 w-3.5" />
						</Link>
					) : null}
					<button
						type="button"
						onClick={() => setCollapsed((prev) => !prev)}
						aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
						className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-surface-raised hover:text-text"
					>
						{collapsed ? (
							<PanelLeftOpen className="h-4 w-4" />
						) : (
							<PanelLeftClose className="h-4 w-4" />
						)}
					</button>
				</div>

				{!collapsed ? (
					<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
						{sidepanel ?? (
							<div className="p-3 text-xs text-text-muted">
								<Link
									to="/search"
									className="flex items-center gap-2 rounded-lg border border-border bg-bg/50 px-3 py-2 text-text hover:border-accent/50"
								>
									<Search className="h-3.5 w-3.5 text-text-muted" />
									<span>Search bots &amp; streams…</span>
								</Link>
							</div>
						)}
					</div>
				) : (
					<div className="flex min-h-0 flex-1 flex-col items-center py-3">
						<Link
							to="/search"
							aria-label="Search"
							className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-text-muted hover:bg-surface-raised hover:text-text"
						>
							<Search className="h-4 w-4" />
						</Link>
					</div>
				)}

				<nav
					aria-label="User sections"
					className={cn(
						"border-t border-border p-1.5",
						collapsed
							? "flex flex-col items-center gap-1"
							: "grid grid-cols-4 gap-1",
					)}
				>
					{TABS.map((tab) => {
						const Icon = tab.icon;
						const active = activeTab === tab.id;
						return (
							<Link
								key={tab.id}
								to={tab.to}
								aria-label={tab.label}
								className={cn(
									"flex min-h-tap flex-col items-center justify-center gap-0.5 rounded-lg px-1.5 py-1 text-[10px] font-medium transition",
									active
										? "bg-accent/15 text-accent"
										: "text-text-muted hover:bg-surface-raised hover:text-text",
									collapsed && "w-10",
								)}
							>
								<Icon className="h-4 w-4 shrink-0" />
								{!collapsed ? <span>{tab.label}</span> : null}
							</Link>
						);
					})}
				</nav>
			</aside>

			{/* Mobile Top Header */}
			{!hideMobileChrome ? (
				<header className="flex items-center justify-between gap-2 border-b border-border bg-surface px-3 py-2 md:hidden">
					<div className="min-w-0 flex items-center gap-2">
						<span className="truncate text-sm font-semibold text-text">
							{mobileTitle ?? "Cadmus"}
						</span>
					</div>
					<div className="flex items-center gap-1.5">
						<Link
							to="/search"
							aria-label="Search"
							className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border text-text-muted hover:text-text"
						>
							<Search className="h-4 w-4" />
						</Link>
						<IdentityChip compact />
					</div>
				</header>
			) : null}

			{/* Main Content Area */}
			<main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
				<ReconnectBar />
				{children}
			</main>

			{/* Mobile 4-Tab Bottom Bar */}
			{!hideMobileChrome ? (
				<nav
					aria-label="Mobile sections"
					className="grid shrink-0 grid-cols-4 border-t border-border bg-surface px-1 pb-[env(safe-area-inset-bottom)] md:hidden"
				>
					{TABS.map((tab) => {
						const Icon = tab.icon;
						const active = activeTab === tab.id;
						return (
							<Link
								key={tab.id}
								to={tab.to}
								className={cn(
									"flex min-h-tap flex-col items-center justify-center gap-0.5 py-1.5 text-[11px] font-medium",
									active ? "text-accent" : "text-text-muted",
								)}
							>
								<Icon className="h-4 w-4" />
								<span>{tab.label}</span>
							</Link>
						);
					})}
				</nav>
			) : null}
		</div>
	);
}
