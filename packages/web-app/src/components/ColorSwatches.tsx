import {
	BOT_PALETTE_SLOTS,
	type BotPaletteSlot,
	botColorVar,
} from "@/lib/bot-color";

export function ColorSwatches({
	value,
	onChange,
}: {
	value: BotPaletteSlot;
	onChange: (slot: BotPaletteSlot) => void;
}) {
	return (
		<div className="flex items-center gap-2">
			{BOT_PALETTE_SLOTS.map((slot) => {
				const selected = slot === value;
				return (
					<button
						key={slot}
						type="button"
						aria-pressed={selected}
						aria-label={`bot-${slot}`}
						className="inline-flex size-8 items-center justify-center rounded-full"
						style={{
							background: botColorVar(slot),
							boxShadow: selected
								? "0 0 0 2px var(--bg), 0 0 0 4px var(--text)"
								: undefined,
						}}
						onClick={() => onChange(slot)}
					>
						{selected ? (
							<span className="text-[length:var(--fs-sm)] font-semibold text-on-accent">
								✓
							</span>
						) : null}
					</button>
				);
			})}
		</div>
	);
}
