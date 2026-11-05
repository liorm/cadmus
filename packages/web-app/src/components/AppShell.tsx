import { Link, Outlet, useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ReconnectBar } from "@/components/ReconnectBar";

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
	return (
		<div className="mx-auto flex h-[100dvh] max-h-[100dvh] w-full max-w-[390px] flex-col overflow-hidden bg-bg pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]">
			{header ?? (
				<header className="flex min-h-tap items-center gap-2 border-b border-border px-2">
					{showBack && backTo ? (
						<Link
							to={backTo}
							aria-label="Back"
							className="inline-flex min-h-tap min-w-tap items-center justify-center text-[length:var(--fs-lg)]"
						>
							‹
						</Link>
					) : showBack ? (
						<button
							type="button"
							aria-label="Back"
							className="inline-flex min-h-tap min-w-tap items-center justify-center text-[length:var(--fs-lg)] disabled:opacity-30"
							onClick={() => router.history.back()}
						>
							‹
						</button>
					) : (
						<span className="inline-flex min-h-tap min-w-tap" />
					)}
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
			<ReconnectBar />
			<main className="flex min-h-0 flex-1 flex-col">
				{children ?? <Outlet />}
			</main>
		</div>
	);
}
