import { Switch } from "@/components/ui/switch";

export function Toggle({
	checked,
	onCheckedChange,
	label,
}: {
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
	label: string;
}) {
	const id = `toggle-${label.replaceAll(/\s+/g, "-").toLowerCase()}`;
	return (
		<div className="flex min-h-tap items-center justify-between gap-3">
			<label htmlFor={id} className="text-[length:var(--fs-md)]">
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
