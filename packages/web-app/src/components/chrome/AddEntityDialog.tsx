import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Shared create/invite/pair overlay across all 3 personas:
 * centered modal on desktop (`md:`), bottom sheet drawer on mobile (`< md`).
 */
export function AddEntityDialog({
	open,
	onClose,
	title,
	description,
	children,
	maxWidthClass = "md:max-w-lg",
}: {
	open: boolean;
	onClose: () => void;
	title: string;
	description?: string;
	children: ReactNode;
	maxWidthClass?: string;
}) {
	return (
		<Dialog.Root
			open={open}
			onOpenChange={(next) => {
				if (!next) onClose();
			}}
		>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px]" />
				<Dialog.Content
					className={cn(
						"fixed inset-x-0 bottom-0 z-50 flex max-h-[88dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-border bg-surface shadow-2xl outline-none",
						"pb-[max(1rem,env(safe-area-inset-bottom))]",
						"md:inset-x-auto md:bottom-auto md:left-1/2 md:top-1/2 md:max-h-[85dvh] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-xl md:pb-0",
						maxWidthClass,
					)}
				>
					<div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
						<div className="min-w-0">
							<Dialog.Title className="text-sm font-semibold text-text">
								{title}
							</Dialog.Title>
							{description ? (
								<Dialog.Description className="mt-0.5 text-xs text-text-muted">
									{description}
								</Dialog.Description>
							) : (
								<Dialog.Description className="sr-only">
									{title}
								</Dialog.Description>
							)}
						</div>
						<Dialog.Close asChild>
							<button
								type="button"
								aria-label="Close dialog"
								className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-surface-raised hover:text-text"
							>
								<X className="h-4 w-4" />
							</button>
						</Dialog.Close>
					</div>
					<div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
						{children}
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
