import { X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Shared create/invite/pair overlay across all 3 personas:
 * native modal <dialog> centered on desktop (`md:`), bottom sheet on mobile (`< md`).
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
	const dialogRef = useRef<HTMLDialogElement>(null);
	const titleId = useId();
	const descId = useId();

	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;
		if (open) {
			if (!dialog.open) dialog.showModal();
		} else if (dialog.open) {
			dialog.close();
		}
	}, [open]);

	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog || "closedBy" in HTMLDialogElement.prototype) return;

		let pressedOutside = false;
		const isOutside = (e: PointerEvent) => {
			const r = dialog.getBoundingClientRect();
			return (
				e.clientX < r.left ||
				e.clientX > r.right ||
				e.clientY < r.top ||
				e.clientY > r.bottom
			);
		};
		const onPointerDown = (e: PointerEvent) => {
			pressedOutside = isOutside(e);
		};
		const onPointerUp = (e: PointerEvent) => {
			if (pressedOutside && isOutside(e)) dialog.close();
		};

		dialog.addEventListener("pointerdown", onPointerDown);
		dialog.addEventListener("pointerup", onPointerUp);
		return () => {
			dialog.removeEventListener("pointerdown", onPointerDown);
			dialog.removeEventListener("pointerup", onPointerUp);
		};
	}, []);

	return (
		<dialog
			ref={dialogRef}
			aria-labelledby={titleId}
			aria-describedby={description ? descId : undefined}
			{...({ closedby: "any" } as Record<string, unknown>)}
			onCancel={(e) => {
				e.preventDefault();
				onClose();
			}}
			onClose={() => {
				if (open) onClose();
			}}
			className={cn(
				"m-0 mt-auto max-h-[88dvh] w-full max-w-none flex-col overflow-hidden rounded-t-2xl border border-border bg-surface p-0 text-text shadow-2xl open:flex",
				"pb-[max(1rem,env(safe-area-inset-bottom))]",
				"md:m-auto md:max-h-[85dvh] md:rounded-xl md:pb-0",
				maxWidthClass,
			)}
		>
			<div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
				<div className="min-w-0">
					<h1 id={titleId} className="text-sm font-semibold text-text">
						{title}
					</h1>
					{description ? (
						<p id={descId} className="mt-0.5 text-xs text-text-muted">
							{description}
						</p>
					) : null}
				</div>
				<button
					type="button"
					aria-label="Close dialog"
					onClick={onClose}
					className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-surface-raised hover:text-text"
				>
					<X className="h-4 w-4" />
				</button>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
				{children}
			</div>
		</dialog>
	);
}
