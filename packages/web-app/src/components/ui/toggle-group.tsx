import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";
import { cn } from "@/lib/utils";

export const ToggleGroup = ToggleGroupPrimitive.Root;

export function ToggleGroupItem({
	className,
	...props
}: ToggleGroupPrimitive.ToggleGroupItemProps) {
	return (
		<ToggleGroupPrimitive.Item
			className={cn(
				"inline-flex min-h-tap min-w-tap items-center justify-center whitespace-nowrap rounded-md px-3 text-[length:var(--fs-sm)] text-text-muted data-[state=on]:bg-surface-raised data-[state=on]:text-text",
				className,
			)}
			{...props}
		/>
	);
}
