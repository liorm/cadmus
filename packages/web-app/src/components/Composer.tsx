import {
	type FormEvent,
	type ReactNode,
	useId,
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
	const inputId = useId();
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
		el.style.height = `${Math.max(32, el.scrollHeight)}px`;
	}, [value]);

	function submit(event?: FormEvent) {
		event?.preventDefault();
		const text = value.trim();
		if (!text || disabled) return;
		onSend(text, steer);
		setValue("");
		setSteer(false);
	}

	const actionButtons = (
		<>
			{onExpand ? (
				<button
					type="button"
					aria-label="Expand"
					onClick={onExpand}
					className="inline-flex min-h-tap min-w-tap shrink-0 items-center justify-center text-text-muted hover:text-text md:min-h-0 md:min-w-0 md:h-8 md:w-8"
				>
					⤢
				</button>
			) : null}
			{steerEnabled ? (
				<button
					type="button"
					aria-pressed={steer}
					aria-label="Steer"
					onClick={() => setSteer(!steer)}
					className={cn(
						"inline-flex min-h-tap shrink-0 items-center justify-center rounded-full border px-2.5 text-xs md:min-h-0 md:h-8",
						steer
							? "border-accent bg-accent text-on-accent"
							: "border-border text-text-muted hover:text-text",
					)}
				>
					↪ Steer
				</button>
			) : null}
			<Button
				type="submit"
				disabled={disabled || !value.trim()}
				aria-label="Send"
				className="min-h-tap min-w-tap shrink-0 rounded-full px-0 md:min-h-0 md:min-w-0 md:h-8 md:w-8"
			>
				↑
			</Button>
		</>
	);

	return (
		<form
			onSubmit={submit}
			className="mx-3 mb-3 mt-1 flex flex-col gap-1.5 rounded-xl border border-border bg-surface px-3 py-2"
		>
			{chips ? (
				<div className="flex flex-wrap items-center gap-2">{chips}</div>
			) : null}
			<div className="flex items-end gap-2">
				<label htmlFor={inputId} className="sr-only">
					Message
				</label>
				<Textarea
					id={inputId}
					ref={areaRef}
					placeholder={placeholder}
					value={value}
					disabled={disabled}
					autoFocus={autoFocus}
					rows={1}
					onChange={(event) => setValue(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							if (
								event.nativeEvent.isComposing ||
								event.nativeEvent.keyCode === 229
							) {
								return;
							}
							submit();
						}
					}}
					className="max-h-48 min-h-8 flex-1 border-0 bg-transparent px-0 py-1 leading-snug"
				/>
				{!leading ? (
					<div className="flex shrink-0 items-center gap-1.5">
						{actionButtons}
					</div>
				) : null}
			</div>
			{leading ? (
				<div className="flex items-center gap-2">
					<div className="min-w-0 flex-1">{leading}</div>
					{actionButtons}
				</div>
			) : null}
		</form>
	);
}
