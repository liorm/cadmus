import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export const Textarea = forwardRef<
	HTMLTextAreaElement,
	TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
	return (
		<textarea
			ref={ref}
			className={cn(
				"min-h-tap w-full resize-none rounded-md border border-border bg-surface px-3 py-2 text-[length:var(--fs-md)] text-text outline-none",
				className,
			)}
			{...props}
		/>
	);
});
