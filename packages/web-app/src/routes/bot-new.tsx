import type { BotRecord } from "@cadmus/contract/types";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { ColorSwatches } from "@/components/ColorSwatches";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useCadmus } from "@/context/CadmusContext";
import {
	type BotPaletteSlot,
	botColorVar,
	botInitials,
	derivedBotColor,
} from "@/lib/bot-color";

export function NewBotPage() {
	const navigate = useNavigate();
	const { client, refreshDirectory, setLastBotId } = useCadmus();
	const [name, setName] = useState("");
	const [soul, setSoul] = useState("");
	const [picked, setPicked] = useState<BotPaletteSlot | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const derived = useMemo(() => derivedBotColor(name), [name]);
	const slot = picked ?? derived;
	const initials = botInitials(name);

	async function create() {
		const trimmed = name.trim();
		if (!trimmed || busy) return;
		setBusy(true);
		setError(null);
		const soulText = soul.trim();
		const created = await client.callRpc<{ bot?: BotRecord }>("bot.create", {
			name: trimmed,
			...(soulText ? { soul: soulText } : {}),
			metadata: { color: `bot-${slot}` },
		});
		if (!created.ok || !created.result?.bot) {
			setBusy(false);
			setError(created.error?.message ?? "Could not create the bot.");
			return;
		}
		setLastBotId(created.result.bot.id);
		await refreshDirectory();
		await navigate({ to: "/" });
	}

	return (
		<AppShell title="New bot" backTo="/">
			<div className="flex min-h-0 flex-1 flex-col">
				<div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
					<div className="mb-5 flex items-center gap-3">
						<span
							aria-hidden="true"
							className="inline-flex size-14 items-center justify-center rounded-2xl text-[length:var(--fs-md)] font-semibold text-on-accent"
							style={{ background: botColorVar(slot) }}
						>
							{initials}
						</span>
						<div className="min-w-0">
							<div className="truncate font-semibold">
								{name.trim() || "New bot"}
							</div>
							<div className="text-[length:var(--fs-sm)] text-text-muted">
								Preview
							</div>
						</div>
					</div>
					<label className="block">
						<span className="text-[length:var(--fs-xs)] font-semibold uppercase tracking-wide text-text-muted">
							Name
						</span>
						<input
							aria-label="Name"
							value={name}
							onChange={(event) => {
								setName(event.target.value);
							}}
							className="mt-2 min-h-tap w-full rounded-md border border-border bg-surface px-3 text-[length:var(--fs-md)] outline-none"
						/>
					</label>
					<div className="mt-5">
						<p className="mb-2 text-[length:var(--fs-xs)] font-semibold uppercase tracking-wide text-text-muted">
							Colour · auto-picked, tap to change
						</p>
						<ColorSwatches
							value={slot}
							onChange={(next) => {
								setPicked(next);
							}}
						/>
					</div>
					<div className="mt-5">
						<label
							htmlFor="new-bot-soul"
							className="text-[length:var(--fs-xs)] font-semibold uppercase tracking-wide text-text-muted"
						>
							Soul / persona · optional
						</label>
						<Textarea
							id="new-bot-soul"
							aria-label="Soul"
							value={soul}
							placeholder="Describe how this bot should behave, e.g. tone, rules, what to ask before acting..."
							onChange={(event) => setSoul(event.target.value)}
							className="mt-2 min-h-48"
						/>
					</div>
					{error ? (
						<p
							role="alert"
							className="mt-3 text-[length:var(--fs-sm)] text-status-failed"
						>
							{error}
						</p>
					) : null}
				</div>
				<div className="px-4 pb-4">
					<Button
						className="w-full rounded-full"
						disabled={busy || name.trim().length === 0}
						onClick={() => void create()}
					>
						Create bot
					</Button>
				</div>
			</div>
		</AppShell>
	);
}
