import * as Dialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export const Sheet = Dialog.Root;
export const SheetTrigger = Dialog.Trigger;
export const SheetClose = Dialog.Close;
export const SheetTitle = Dialog.Title;
export const SheetDescription = Dialog.Description;
export const SheetPortal = Dialog.Portal;

export function SheetOverlay({ className }: { className?: string }) {
	return (
		<Dialog.Overlay className={cn("fixed inset-0 z-40 bg-bg/70", className)} />
	);
}

export function SheetContent({
	className,
	children,
}: {
	className?: string;
	children: ReactNode;
}) {
	return (
		<SheetPortal>
			<SheetOverlay />
			<Dialog.Content
				className={cn(
					"fixed inset-x-0 bottom-0 z-50 mx-auto max-w-[390px] rounded-t-lg border border-border bg-surface p-4 pb-[max(var(--sp-4),env(safe-area-inset-bottom))] shadow-[var(--shadow)]",
					className,
				)}
			>
				{children}
			</Dialog.Content>
		</SheetPortal>
	);
}
