import { Link } from "@tanstack/react-router";
import {
	ArrowRightLeft,
	FileClock,
	KeyRound,
	LayoutDashboard,
	Users,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { ElevationPill } from "@/components/chrome/ElevationPill";
import { IdentityChip } from "@/components/chrome/IdentityChip";
import { PersonaBadge } from "@/components/chrome/PersonaBadge";
import { useSession } from "@/context/SessionContext";
import { selectAccount } from "@/lib/session";
import { cn } from "@/lib/utils";

export type AdminTab = "overview" | "members" | "providers" | "audit";

const NAV_ITEMS: Array<{
	id: AdminTab;
	label: string;
	to: "/admin" | "/admin/members" | "/admin/providers" | "/admin/audit";
	icon: typeof LayoutDashboard;
}> = [
	{ id: "overview", label: "Overview", to: "/admin", icon: LayoutDashboard },
	{ id: "members", label: "Members", to: "/admin/members", icon: Users },
	{
		id: "providers",
		label: "Providers",
		to: "/admin/providers",
		icon: KeyRound,
	},
	{ id: "audit", label: "Audit", to: "/admin/audit", icon: FileClock },
];

export function AccountAdminShell({
	activeTab,
	title,
	actions,
	children,
}: {
	activeTab: AdminTab;
	title: string;
	actions?: ReactNode;
	children: ReactNode;
}) {
	const session = useSession();
	const principal = session.principal;
	const membership = session.memberships.find(
		(m) => m.accountId === principal?.accountId,
	);
	const canOpenUserHat = Boolean(membership?.roles.includes("user"));
	const [switchingHat, setSwitchingHat] = useState(false);

	async function switchToUserHat() {
		if (!session.tokens || !principal) return;
		setSwitchingHat(true);
		try {
			const res = await fetch("/api/auth/assumeRole", {
				method: "POST",
				credentials: "same-origin",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${session.tokens.accessToken}`,
					Origin: window.location.origin,
				},
				body: JSON.stringify({
					id: "assume-user-hat",
					type: "auth.assumeRole",
					payload: { role: "user", accountId: principal.accountId },
				}),
			});
			if (res.ok) {
				selectAccount(null);
				window.location.assign("/app");
			}
		} finally {
			setSwitchingHat(false);
		}
	}

	return (
		<div className="flex h-[100dvh] w-full flex-col overflow-hidden bg-bg text-text md:flex-row">
			{/* Desktop Left Sidebar */}
			<aside
				aria-label="Account Admin navigation"
				className="hidden w-64 shrink-0 flex-col border-r border-border bg-surface md:flex"
			>
				<div className="border-b border-border px-4 py-3.5">
					<div className="flex items-center justify-between gap-2">
						<span className="text-sm font-bold tracking-tight text-text">
							Cadmus
						</span>
						<PersonaBadge persona="account-admin" />
					</div>
					<p className="mt-1 truncate text-xs text-text-muted">
						{membership?.name || principal?.accountId || "Account Governance"}
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

				{canOpenUserHat ? (
					<div className="border-t border-border p-3">
						<button
							type="button"
							disabled={switchingHat}
							onClick={() => void switchToUserHat()}
							className="flex min-h-tap w-full items-center justify-between gap-2 rounded-lg border border-border bg-bg/60 px-3 py-2 text-left text-xs text-text-muted hover:border-accent/50 hover:text-text disabled:opacity-50"
						>
							<span className="min-w-0">
								<span className="block font-semibold text-text">
									Open User Workspace
								</span>
								<span className="block truncate text-[11px] text-text-muted">
									Bots, streams &amp; tools envs
								</span>
							</span>
							<ArrowRightLeft className="h-3.5 w-3.5 shrink-0 text-accent" />
						</button>
					</div>
				) : null}
			</aside>

			{/* Main Column */}
			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				<header className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface px-4 py-2.5 sm:px-6">
					<div className="flex min-w-0 items-center gap-2.5">
						<span className="md:hidden">
							<PersonaBadge persona="account-admin" />
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
					<div className="mx-auto max-w-5xl">{children}</div>
				</main>

				{/* Mobile Triage Bottom Nav */}
				<nav
					aria-label="Account Admin mobile navigation"
					className="grid shrink-0 grid-cols-4 border-t border-border bg-surface px-1 pb-[env(safe-area-inset-bottom)] md:hidden"
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
