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
	chips,
	steerEnabled = false,
	steerOn,
	onSteerChange,
	onExpand,
	disabled,
	autoFocus,
}: {
	onSend: (text: string, steer: boolean) => void;
	placeholder?: string;
	leading?: ReactNode;
	chips?: ReactNode;
	steerEnabled?: boolean;
	steerOn?: boolean;
	onSteerChange?: (steer: boolean) => void;
	onExpand?: () => void;
	disabled?: boolean;
	autoFocus?: boolean;
}) {
	const [value, setValue] = useState("");
	const [innerSteer, setInnerSteer] = useState(false);
	const areaRef = useRef<HTMLTextAreaElement>(null);
	const steer = steerOn ?? innerSteer;

	function setSteer(next: boolean) {
		setInnerSteer(next);
		onSteerChange?.(next);
	}

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
			className="m-3 flex flex-col gap-2 rounded-lg border border-border bg-surface p-3"
		>
			{chips ? (
				<div className="flex flex-wrap items-center gap-2">{chips}</div>
			) : null}
			<div className="flex items-start gap-2">
				<Textarea
					ref={areaRef}
					aria-label="Message"
					placeholder={placeholder}
					value={value}
					disabled={disabled}
					autoFocus={autoFocus}
					rows={1}
					onChange={(event) => setValue(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							submit();
						}
					}}
					className="max-h-48 min-h-tap border-0 bg-transparent px-0 py-1"
				/>
				{onExpand ? (
					<button
						type="button"
						aria-label="Expand"
						onClick={onExpand}
						className="inline-flex min-h-tap min-w-tap items-center justify-center text-text-muted"
					>
						⤢
					</button>
				) : null}
			</div>
			<div className="flex items-center gap-2">
				<div className="min-w-0 flex-1">{leading}</div>
				{steerEnabled ? (
					<button
						type="button"
						aria-pressed={steer}
						aria-label="Steer"
						onClick={() => setSteer(!steer)}
						className={cn(
							"inline-flex min-h-tap items-center justify-center rounded-full border px-3 text-[length:var(--fs-sm)]",
							steer
								? "border-accent bg-accent text-on-accent"
								: "border-border text-text-muted",
						)}
					>
						↪ Steer
					</button>
				) : null}
				<Button
					type="submit"
					disabled={disabled || !value.trim()}
					aria-label="Send"
					className="min-h-tap min-w-tap rounded-full px-0"
				>
					↑
				</Button>
			</div>
		</form>
	);
}
