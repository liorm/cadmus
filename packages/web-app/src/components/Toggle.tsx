import type { ReactNode } from "react";
import { Switch } from "@/components/ui/switch";

export function Toggle({
	checked,
	onCheckedChange,
	label,
	leading,
}: {
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
	label: string;
	leading?: ReactNode;
}) {
	const id = `toggle-${label.replaceAll(/\s+/g, "-").toLowerCase()}`;
	return (
		<div className="flex min-h-tap items-center justify-between gap-3">
			<label
				htmlFor={id}
				className="flex flex-1 items-center gap-3 text-[length:var(--fs-md)]"
			>
				{leading}
				{label}
			</label>
			<Switch
				id={id}
				checked={checked}
				onCheckedChange={onCheckedChange}
				aria-label={label}
			/>
		</div>
	);
}
