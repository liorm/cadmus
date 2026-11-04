import {
	type FormEvent,
	type ReactNode,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export function Composer({
	onSend,
	placeholder = "Message",
	leading,
	steerEnabled = false,
	disabled,
}: {
	onSend: (text: string, steer: boolean) => void;
	placeholder?: string;
	leading?: ReactNode;
	steerEnabled?: boolean;
	disabled?: boolean;
}) {
	const [value, setValue] = useState("");
	const [steer, setSteer] = useState(false);
	const areaRef = useRef<HTMLTextAreaElement>(null);

	// The controlled value is not read in the body; scrollHeight changes with it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: remeasure when the controlled value changes
	useLayoutEffect(() => {
		const el = areaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.max(44, el.scrollHeight)}px`;
	}, [value]);

	function submit(event?: FormEvent) {
		event?.preventDefault();
		const text = value.trim();
		if (!text || disabled) return;
		onSend(text, steer);
		setValue("");
		setSteer(false);
	}

	return (
		<form
			onSubmit={submit}
			className="flex flex-col gap-2 border-t border-border bg-surface p-3"
		>
			{leading}
			<div className="flex items-end gap-2">
				<Textarea
					ref={areaRef}
					aria-label="Message"
					placeholder={placeholder}
					value={value}
					disabled={disabled}
					rows={1}
					onChange={(event) => setValue(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							submit();
						}
					}}
					className="max-h-40 min-h-tap"
				/>
				{steerEnabled ? (
					<button
						type="button"
						aria-pressed={steer}
						aria-label="Steer"
						onClick={() => setSteer((current) => !current)}
						className={cn(
							"inline-flex min-h-tap min-w-tap items-center justify-center rounded-md px-2 text-[length:var(--fs-sm)]",
							steer
								? "bg-accent text-on-accent"
								: "border border-border text-text-muted",
						)}
					>
						↪ Steer
					</button>
				) : null}
				<Button type="submit" disabled={disabled || !value.trim()}>
					Send
				</Button>
			</div>
		</form>
	);
}
