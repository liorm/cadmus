import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

export function SegmentedControl({
	value,
	onValueChange,
	options,
	ariaLabel,
	scroll = false,
}: {
	value: string;
	onValueChange: (value: string) => void;
	options: ReadonlyArray<{ value: string; label: string }>;
	ariaLabel: string;
	scroll?: boolean;
}) {
	return (
		<ToggleGroup
			type="single"
			value={value}
			onValueChange={(next) => {
				if (next) onValueChange(next);
			}}
			aria-label={ariaLabel}
			className={cn(
				"flex gap-1 rounded-md bg-surface p-1",
				scroll ? "overflow-x-auto" : "justify-center",
			)}
		>
			{options.map((option) => (
				<ToggleGroupItem key={option.value} value={option.value}>
					{option.label}
				</ToggleGroupItem>
			))}
		</ToggleGroup>
	);
}
