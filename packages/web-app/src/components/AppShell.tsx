import { Link, Outlet, useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";

export function AppShell({
	title,
	backTo,
	showBack = true,
	actions,
	children,
}: {
	title: string;
	backTo?: string;
	showBack?: boolean;
	actions?: ReactNode;
	children?: ReactNode;
}) {
	const router = useRouter();
	return (
		<div className="mx-auto flex min-h-[100dvh] w-full max-w-[390px] flex-col bg-bg pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]">
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
				<h1 className="flex-1 text-[length:var(--fs-lg)] font-semibold">
					{title}
				</h1>
				{actions}
			</header>
			<main className="flex min-h-0 flex-1 flex-col">
				{children ?? <Outlet />}
			</main>
		</div>
	);
}
