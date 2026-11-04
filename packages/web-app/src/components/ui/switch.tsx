import * as SwitchPrimitive from "@radix-ui/react-switch";
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";

export function Switch({
	className,
	...props
}: ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>) {
	return (
		<SwitchPrimitive.Root
			className={cn(
				"inline-flex h-tap w-14 shrink-0 cursor-pointer items-center rounded-full border border-border bg-surface-raised p-1 data-[state=checked]:bg-accent",
				className,
			)}
			{...props}
		>
			<SwitchPrimitive.Thumb className="block size-8 rounded-full bg-text transition-transform data-[state=checked]:translate-x-5 data-[state=checked]:bg-on-accent" />
		</SwitchPrimitive.Root>
	);
}
