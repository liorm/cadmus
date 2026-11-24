import { Link } from "@tanstack/react-router";
import { Activity, Building2, FileClock } from "lucide-react";
import type { ReactNode } from "react";
import { ElevationPill } from "@/components/chrome/ElevationPill";
import { IdentityChip } from "@/components/chrome/IdentityChip";
import { PersonaBadge } from "@/components/chrome/PersonaBadge";
import { cn } from "@/lib/utils";

export type SystemTab = "metrics" | "tenants" | "audit";

const NAV_ITEMS: Array<{
	id: SystemTab;
	label: string;
	to: "/system" | "/system/tenants" | "/system/audit";
	icon: typeof Activity;
}> = [
	{ id: "metrics", label: "Metrics", to: "/system", icon: Activity },
	{ id: "tenants", label: "Tenants", to: "/system/tenants", icon: Building2 },
	{ id: "audit", label: "Audit", to: "/system/audit", icon: FileClock },
];

export function SuperAdminShell({
	activeTab,
	title,
	actions,
	children,
}: {
	activeTab: SystemTab;
	title: string;
	actions?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="flex h-[100dvh] w-full flex-col overflow-hidden bg-bg text-text md:flex-row">
			{/* Desktop Left Sidebar */}
			<aside
				aria-label="Super Admin navigation"
				className="hidden w-64 shrink-0 flex-col border-r border-border bg-surface md:flex"
			>
				<div className="border-b border-border px-4 py-3.5">
					<div className="flex items-center justify-between gap-2">
						<span className="text-sm font-bold tracking-tight text-text">
							Cadmus
						</span>
						<PersonaBadge persona="super-admin" />
					</div>
					<p className="mt-1 text-xs text-text-muted">
						Platform Operations &amp; Tenants
					</p>
				</div>

				<nav className="flex-1 space-y-1 p-2.5">
					{NAV_ITEMS.map((item) => {
						const Icon = item.icon;
						const active = activeTab === item.id;
						return (
							<Link
								key={item.id}
								to={item.to}
								className={cn(
									"flex min-h-tap items-center gap-2.5 rounded-lg px-3 text-xs font-medium transition",
									active
										? "bg-accent/15 text-accent"
										: "text-text-muted hover:bg-surface-raised hover:text-text",
								)}
							>
								<Icon className="h-4 w-4 shrink-0" />
								<span>{item.label}</span>
							</Link>
						);
					})}
				</nav>

				<div className="border-t border-border p-3 text-[11px] text-text-muted">
					Privacy boundary enforced: tenant bot chats and memories are never
					accessible here.
				</div>
			</aside>

			{/* Main Column */}
			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				<header className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface px-4 py-2.5 sm:px-6">
					<div className="flex min-w-0 items-center gap-2.5">
						<span className="md:hidden">
							<PersonaBadge persona="super-admin" />
						</span>
						<h1 className="truncate text-sm font-semibold text-text">
							{title}
						</h1>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						{actions}
						<ElevationPill />
						<IdentityChip className="md:w-auto" />
					</div>
				</header>

				<main className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
					<div className="mx-auto max-w-6xl">{children}</div>
				</main>

				{/* Mobile Triage Bottom Nav */}
				<nav
					aria-label="Super Admin mobile navigation"
					className="grid shrink-0 grid-cols-3 border-t border-border bg-surface px-1 pb-[env(safe-area-inset-bottom)] md:hidden"
				>
					{NAV_ITEMS.map((item) => {
						const Icon = item.icon;
						const active = activeTab === item.id;
						return (
							<Link
								key={item.id}
								to={item.to}
								className={cn(
									"flex min-h-tap flex-col items-center justify-center gap-0.5 py-1.5 text-[11px] font-medium",
									active ? "text-accent" : "text-text-muted",
								)}
							>
								<Icon className="h-4 w-4" />
								<span>{item.label}</span>
							</Link>
						);
					})}
				</nav>
			</div>
		</div>
	);
}
