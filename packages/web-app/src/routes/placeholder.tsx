import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AppShell } from "@/components/AppShell";

export function PlaceholderPage({
	title,
	children,
}: {
	title: string;
	children?: ReactNode;
}) {
	return (
		<AppShell title={title} backTo="/">
			<div className="flex flex-1 flex-col gap-3 p-4 text-text-muted">
				<p>This screen is a route placeholder. A later ticket fills it in.</p>
				{children}
				<nav className="flex flex-col gap-2 text-accent">
					<Link to="/">Home</Link>
					<Link to="/settings">Settings</Link>
					<Link to="/search">Search</Link>
				</nav>
			</div>
		</AppShell>
	);
}
