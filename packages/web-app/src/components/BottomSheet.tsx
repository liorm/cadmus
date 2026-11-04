import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetTitle,
	SheetTrigger,
} from "@/components/ui/sheet";

export function BottomSheet({
	open,
	onOpenChange,
	title,
	description,
	children,
	cancelLabel = "Cancel",
	trigger,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description?: string;
	children?: ReactNode;
	cancelLabel?: string;
	trigger?: ReactNode;
}) {
	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			{trigger ? <SheetTrigger asChild>{trigger}</SheetTrigger> : null}
			<SheetContent>
				<SheetTitle className="text-[length:var(--fs-lg)] text-text">
					{title}
				</SheetTitle>
				{description ? (
					<SheetDescription className="mt-1 text-[length:var(--fs-sm)] text-text-muted">
						{description}
					</SheetDescription>
				) : (
					<SheetDescription className="sr-only">{title}</SheetDescription>
				)}
				<div className="mt-3 flex flex-col gap-1">{children}</div>
				<Button
					variant="outlined"
					className="mt-3 w-full"
					onClick={() => onOpenChange(false)}
				>
					{cancelLabel}
				</Button>
			</SheetContent>
		</Sheet>
	);
}
