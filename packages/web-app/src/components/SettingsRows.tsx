import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

export function SettingsSection({
	title,
	children,
}: {
	title: string;
	children: ReactNode;
}) {
	const sectionId = `settings-${title.toLowerCase().replace(/\s+/g, "-")}`;
	return (
		<section aria-labelledby={sectionId} className="flex flex-col gap-2">
			<h2
				id={sectionId}
				className="px-1 text-[length:var(--fs-xs)] font-semibold uppercase tracking-wide text-text-muted"
			>
				{title}
			</h2>
			<div className="overflow-hidden rounded-md border border-border bg-surface">
				{children}
			</div>
		</section>
	);
}

export function SettingsLink({
	to,
	title,
	hint,
}: {
	to: string;
	title: string;
	hint: string;
}) {
	return (
		<Link
			to={to}
			className="flex min-h-tap w-full items-center gap-3 border-b border-border px-4 py-3 text-left last:border-b-0"
		>
			<span className="min-w-0 flex-1">
				<span className="block font-semibold">{title}</span>
				<span className="block truncate text-[length:var(--fs-sm)] text-text-muted">
					{hint}
				</span>
			</span>
			<span aria-hidden="true" className="text-text-muted">
				›
			</span>
		</Link>
	);
}

export const fieldClass =
	"w-full rounded-md border border-border bg-bg px-3 py-2 text-[length:var(--fs-md)]";
