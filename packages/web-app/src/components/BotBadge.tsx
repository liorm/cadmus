import { type BotColorSource, botColor, botColorVar } from "@/lib/bot-color";
import { cn } from "@/lib/utils";

export function BotBadge({
	bot,
	className,
}: {
	bot: BotColorSource & { name?: string };
	className?: string;
}) {
	const slot = botColor(bot);
	const initial = (bot.name ?? bot.id).slice(0, 1).toUpperCase();
	return (
		<span
			className={cn(
				"inline-flex size-tap items-center justify-center rounded-full text-[length:var(--fs-sm)] font-semibold text-on-accent",
				className,
			)}
			style={{ background: botColorVar(slot) }}
			aria-hidden="true"
		>
			{initial}
		</span>
	);
}
