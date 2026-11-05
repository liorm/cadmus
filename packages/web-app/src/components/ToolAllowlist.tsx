import { DEFAULT_CADMUS_TOOL_NAMES } from "@cadmus/contract/tools";
import type { BotRecord } from "@cadmus/contract/types";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useCadmus } from "@/context/CadmusContext";
import { allowlistCount, TOOL_CATALOGUE } from "@/lib/allowlist-count";

export function ToolAllowlist({
	bot,
	onSaved,
}: {
	bot: BotRecord;
	onSaved: () => Promise<void> | void;
}) {
	const { client } = useCadmus();
	const [selected, setSelected] = useState<string[]>(
		() => bot.tools ?? [...DEFAULT_CADMUS_TOOL_NAMES],
	);
	const count = allowlistCount(selected);

	function toggle(name: string, on: boolean) {
		setSelected((prev) => {
			const base = prev.includes(name) || !on ? prev : [...prev, name];
			return on
				? Array.from(new Set([...base, name]))
				: base.filter((item) => item !== name);
		});
	}

	function isDefaultSet(names: readonly string[]): boolean {
		if (names.length !== DEFAULT_CADMUS_TOOL_NAMES.length) return false;
		const have = new Set(names);
		return DEFAULT_CADMUS_TOOL_NAMES.every((name) => have.has(name));
	}

	async function save(tools: string[] | null) {
		await client.callRpc("bot.update", { botId: bot.id, tools });
		await onSaved();
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<p className="px-3 pt-3 text-[length:var(--fs-sm)] text-text-muted">
				{count.label}
			</p>
			<div className="min-h-0 flex-1 overflow-y-auto px-3">
				{TOOL_CATALOGUE.map((name) => {
					const on = selected.includes(name);
					return (
						<div
							key={name}
							className="flex min-h-tap items-center justify-between gap-3 border-b border-border"
						>
							<span className="font-mono text-[length:var(--fs-sm)]">
								{name}
							</span>
							<Switch
								checked={on}
								aria-label={name}
								onCheckedChange={(checked) => toggle(name, checked)}
							/>
						</div>
					);
				})}
			</div>
			<div className="flex flex-col gap-2 p-3">
				<Button
					onClick={() => void save(isDefaultSet(selected) ? null : selected)}
				>
					Save
				</Button>
				<Button
					variant="outlined"
					onClick={() => {
						setSelected([...DEFAULT_CADMUS_TOOL_NAMES]);
						void save(null);
					}}
				>
					Reset to default
				</Button>
			</div>
		</div>
	);
}
