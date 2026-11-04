import type { BotRecord } from "@cadmus/contract/types";
import { botColor, botColorVar } from "@/lib/bot-color";
import { cn } from "@/lib/utils";

export function BotChip({
	bots,
	value,
	onChange,
	disabled,
	className,
}: {
	bots: BotRecord[];
	value?: string;
	onChange?: (id: string) => void;
	disabled?: boolean;
	className?: string;
}) {
	if (bots.length === 0) {
		return (
			<span className="text-[length:var(--fs-sm)] text-text-muted">
				No bots yet
			</span>
		);
	}
	const selected = bots.find((bot) => bot.id === value) ?? bots[0];
	if (!selected) return null;
	const slot = botColor(selected);
	return (
		<label
			className={cn(
				"inline-flex min-h-tap items-center gap-2 rounded-full border border-border px-3 text-[length:var(--fs-sm)]",
				className,
			)}
			style={{ color: botColorVar(slot) }}
		>
			<span
				aria-hidden="true"
				className="size-2 rounded-full"
				style={{ background: botColorVar(slot) }}
			/>
			<select
				aria-label="Bot"
				disabled={disabled}
				value={selected.id}
				onChange={(event) => onChange?.(event.target.value)}
				className="max-w-40 bg-transparent text-[length:var(--fs-sm)] outline-none"
			>
				{bots.map((bot) => (
					<option key={bot.id} value={bot.id}>
						{bot.name}
					</option>
				))}
			</select>
		</label>
	);
}

export function BotPill({
	bot,
}: {
	bot: { id: string; name: string; metadata?: { color?: unknown } | null };
}) {
	const slot = botColor(bot);
	return (
		<span
			className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[length:var(--fs-xs)]"
			style={{ color: botColorVar(slot) }}
		>
			<span
				aria-hidden="true"
				className="size-1.5 rounded-full"
				style={{ background: botColorVar(slot) }}
			/>
			{bot.name}
		</span>
	);
}
