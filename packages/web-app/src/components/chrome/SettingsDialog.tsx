import * as Dialog from "@radix-ui/react-dialog";
import { type LucideIcon, X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SettingsDialogTab<T extends string = string> {
	id: T;
	label: string;
	icon?: LucideIcon;
}

/**
 * Shared fixed-size settings dialog with a left-side tab rail (desktop) and
 * top scrollable tab bar (mobile). Enforces consistent dimensions across tab
 * switches for all settings popups (User/Account, Family, and future dialogs).
 */
export function SettingsDialog<T extends string>({
	open,
	onClose,
	title,
	description,
	tabs,
	activeTab,
	onTabChange,
	closeLabel = "Close settings dialog",
	tabsLabel = "Settings sections",
	footer,
	children,
}: {
	open: boolean;
	onClose: () => void;
	title: string;
	description?: string;
	tabs: ReadonlyArray<SettingsDialogTab<T>>;
	activeTab: T;
	onTabChange: (tab: T) => void;
	closeLabel?: string;
	tabsLabel?: string;
	footer?: ReactNode;
	children: ReactNode;
}) {
	return (
		<Dialog.Root
			open={open}
			onOpenChange={(next) => {
				if (!next) onClose();
			}}
		>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px]" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex h-[min(640px,85dvh)] w-[calc(100%-2rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl outline-none">
					<div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
						<div className="min-w-0">
							<Dialog.Title className="text-sm font-semibold text-text">
								{title}
							</Dialog.Title>
							{description ? (
								<Dialog.Description className="truncate text-xs text-text-muted">
									{description}
								</Dialog.Description>
							) : null}
						</div>
						<Dialog.Close asChild>
							<button
								type="button"
								aria-label={closeLabel}
								className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-surface-raised hover:text-text"
							>
								<X className="h-4 w-4" />
							</button>
						</Dialog.Close>
					</div>

					<div className="flex min-h-0 flex-1 flex-col sm:flex-row">
						<div
							role="tablist"
							aria-label={tabsLabel}
							className="flex shrink-0 gap-1 overflow-x-auto border-b border-border p-2 sm:w-44 sm:flex-col sm:border-b-0 sm:border-r sm:p-2.5"
						>
							{tabs.map((item) => {
								const Icon = item.icon;
								const active = activeTab === item.id;
								return (
									<button
										key={item.id}
										type="button"
										role="tab"
										aria-selected={active}
										onClick={() => onTabChange(item.id)}
										className={cn(
											"inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition sm:w-full",
											active
												? "bg-accent/15 text-accent"
												: "text-text-muted hover:bg-surface-raised hover:text-text",
										)}
									>
										{Icon ? <Icon className="h-3.5 w-3.5 shrink-0" /> : null}
										<span>{item.label}</span>
									</button>
								);
							})}
						</div>

						<div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
							{children}
						</div>
					</div>

					{footer ? (
						<div className="shrink-0 border-t border-border p-4">{footer}</div>
					) : null}
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
