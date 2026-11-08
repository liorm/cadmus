import { Link, Outlet, useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useDesktopViewport } from "@/components/desktop/use-desktop-viewport";
import { ReconnectBar } from "@/components/ReconnectBar";
import { cn } from "@/lib/utils";

export function AppShell({
	title,
	titleMuted,
	titleNode,
	subtitle,
	backTo,
	showBack = true,
	actions,
	header,
	children,
}: {
	title: string;
	titleMuted?: boolean;
	titleNode?: ReactNode;
	subtitle?: ReactNode;
	backTo?: string;
	showBack?: boolean;
	actions?: ReactNode;
	header?: ReactNode;
	children?: ReactNode;
}) {
	const router = useRouter();
	const desktop = useDesktopViewport();
	return (
		<div
			className={cn(
				"flex flex-col overflow-hidden bg-bg",
				desktop
					? "h-full w-full"
					: "mx-auto h-[100dvh] max-h-[100dvh] w-full max-w-[390px] pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] md:max-w-none",
			)}
		>
			{header ?? (
				<header className="flex min-h-tap items-center gap-2 border-b border-border px-3 py-2">
					{!desktop && showBack && backTo ? (
						<Link
							to={backTo}
							aria-label="Back"
							className="inline-flex min-h-tap min-w-tap items-center justify-center text-[length:var(--fs-lg)]"
						>
							‹
						</Link>
					) : !desktop && showBack ? (
						<button
							type="button"
							aria-label="Back"
							className="inline-flex min-h-tap min-w-tap items-center justify-center text-[length:var(--fs-lg)] disabled:opacity-30"
							onClick={() => router.history.back()}
						>
							‹
						</button>
					) : null}
					<div className="flex min-w-0 flex-1 flex-col">
						{titleNode ?? (
							<h1
								className={`truncate text-[length:var(--fs-lg)] font-semibold ${titleMuted ? "text-text-muted" : ""}`}
							>
								{title}
							</h1>
						)}
						{titleNode ? null : subtitle}
					</div>
					{actions}
				</header>
			)}
			{!desktop && <ReconnectBar />}
			<main className="flex min-h-0 flex-1 flex-col">
				{children ?? <Outlet />}
			</main>
		</div>
	);
}
