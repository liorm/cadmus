import {
	availableAllowlistCatalog,
	categorySelectionState,
	displayedAllowlist,
	knownReadOnlyToolNames,
	persistAllowlist,
	sameToolSet,
	TOOL_CATEGORIES,
} from "@cadmus/contract/tools";
import type { BotRecord } from "@cadmus/contract/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useCadmus } from "@/context/CadmusContext";
import { allowlistCount } from "@/lib/allowlist-count";

export function ToolAllowlist({
	bot,
	onSaved,
}: {
	bot: BotRecord;
	onSaved: () => Promise<void> | void;
}) {
	const { client } = useCadmus();
	const [saveError, setSaveError] = useState<string | null>(null);

	const catalog = useMemo(
		() => availableAllowlistCatalog(bot.model),
		[bot.model],
	);
	const available = useMemo(
		() => catalog.map((entry) => entry.name),
		[catalog],
	);
	const readonlyNames = useMemo(
		() => knownReadOnlyToolNames(available),
		[available],
	);

	const isDefault = bot.tools === undefined;
	const storedKey = bot.tools ? bot.tools.join("\0") : "";
	const storedToolsRef = useRef(bot.tools);
	storedToolsRef.current = bot.tools;

	const [selected, setSelected] = useState<string[]>(() =>
		displayedAllowlist({
			stored: bot.tools,
			available,
			model: bot.model,
		}),
	);
	const [readOnlyOn, setReadOnlyOn] = useState<boolean>(() => {
		const initial = displayedAllowlist({
			stored: bot.tools,
			available,
			model: bot.model,
		});
		return readonlyNames.length > 0 && sameToolSet(initial, readonlyNames);
	});
	const preReadOnly = useRef<string[] | null>(null);

	useEffect(() => {
		void isDefault;
		void storedKey;
		const next = displayedAllowlist({
			stored: storedToolsRef.current,
			available,
			model: bot.model,
		});
		setSelected(next);
		setReadOnlyOn(readonlyNames.length > 0 && sameToolSet(next, readonlyNames));
		preReadOnly.current = null;
	}, [isDefault, storedKey, available, readonlyNames, bot.model]);

	const count = allowlistCount(selected, bot.model);

	function toggle(name: string, on: boolean) {
		setReadOnlyOn(false);
		preReadOnly.current = null;
		setSelected((prev) => {
			const base = prev.includes(name) || !on ? prev : [...prev, name];
			return on
				? Array.from(new Set([...base, name]))
				: base.filter((item) => item !== name);
		});
	}

	function setCategory(members: readonly string[], on: boolean) {
		setReadOnlyOn(false);
		preReadOnly.current = null;
		setSelected((prev) => {
			const drop = new Set(members);
			const kept = prev.filter((name) => !drop.has(name));
			return on ? [...kept, ...members] : kept;
		});
	}

	function applyReadOnly(on: boolean) {
		if (on) {
			if (!readOnlyOn) preReadOnly.current = selected;
			setSelected(readonlyNames);
			setReadOnlyOn(true);
			return;
		}
		const snapshot = preReadOnly.current;
		preReadOnly.current = null;
		setReadOnlyOn(false);
		if (!snapshot) return;
		const availableSet = new Set(available);
		setSelected(snapshot.filter((name) => availableSet.has(name)));
	}

	async function save(tools: string[] | null) {
		const res = await client.callRpc("bot.update", { botId: bot.id, tools });
		if (!res.ok) {
			setSaveError(res.error?.message ?? "Could not save allowlist");
			return;
		}
		setSaveError(null);
		await onSaved();
	}

	function persistCurrent(nextSelected: string[]) {
		return persistAllowlist({
			selected: nextSelected,
			available,
			previous: storedToolsRef.current,
			model: bot.model,
		});
	}

	const selectedSet = new Set(selected);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<p className="px-3 pt-3 text-[length:var(--fs-sm)] text-text-muted">
				{count.label}
			</p>
			{saveError ? (
				<p
					role="alert"
					className="px-3 text-[length:var(--fs-sm)] text-status-failed"
				>
					{saveError}
				</p>
			) : null}
			<div className="flex min-h-tap items-center justify-between gap-3 border-b border-border px-3">
				<span className="font-semibold">Read-only mode</span>
				<Switch
					checked={readOnlyOn}
					aria-label="Read-only mode"
					onCheckedChange={(checked) => applyReadOnly(checked)}
				/>
			</div>
			<div
				className="min-h-0 flex-1 overflow-y-auto px-3"
				data-testid="tool-allowlist"
			>
				{TOOL_CATEGORIES.map((category) => {
					const members = catalog
						.filter((entry) => entry.category === category.id)
						.map((entry) => entry.name);
					if (members.length === 0) return null;
					const state = categorySelectionState(members, selectedSet);
					return (
						<section key={category.id} className="mb-3">
							<div className="flex min-h-tap items-center justify-between gap-3 border-b border-border">
								<span className="font-semibold">{category.label}</span>
								<input
									type="checkbox"
									aria-label={category.label}
									checked={state === "all"}
									ref={(node) => {
										if (node) node.indeterminate = state === "mixed";
									}}
									aria-checked={state === "mixed" ? "mixed" : state === "all"}
									onChange={(event) =>
										setCategory(members, event.target.checked)
									}
								/>
							</div>
							{members.map((name) => {
								const on = selectedSet.has(name);
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
						</section>
					);
				})}
			</div>
			<div className="flex flex-col gap-2 p-3">
				<Button onClick={() => void save(persistCurrent(selected))}>
					Save
				</Button>
				<Button
					variant="outlined"
					onClick={() => {
						preReadOnly.current = null;
						setReadOnlyOn(false);
						const next = displayedAllowlist({
							stored: undefined,
							available,
							model: bot.model,
						});
						setSelected(next);
						void save(null);
					}}
				>
					Reset to default
				</Button>
			</div>
		</div>
	);
}
