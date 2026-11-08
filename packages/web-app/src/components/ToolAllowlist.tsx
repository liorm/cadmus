import {
	availableAllowlistCatalog,
	availableAllowlistNames,
	categorySelectionState,
	codingToolsEnvWouldOffer,
	displayedAllowlist,
	knownReadOnlyToolNames,
	persistAllowlist,
	sameToolSet,
	TOOL_CATEGORIES,
} from "@cadmus/contract/tools";
import type { BotRecord, ToolsEnvRecord } from "@cadmus/contract/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { LoadError, SkeletonBlock } from "@/components/Skeleton";
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
	const [envs, setEnvs] = useState<ToolsEnvRecord[] | null>(null);
	const [defaultEnvId, setDefaultEnvId] = useState<string | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [loadAttempt, setLoadAttempt] = useState(0);
	const [selected, setSelected] = useState<string[]>([]);
	const [readOnlyOn, setReadOnlyOn] = useState(false);
	const preReadOnly = useRef<string[] | null>(null);
	const envGen = useRef(0);
	const storedToolsRef = useRef(bot.tools);
	storedToolsRef.current = bot.tools;
	const envKey =
		bot.toolsEnv == null
			? "inherit"
			: `${bot.toolsEnv.enabled}:${bot.toolsEnv.binding?.envId ?? ""}`;
	const toolsEnvRef = useRef(bot.toolsEnv);
	toolsEnvRef.current = bot.toolsEnv;

	const codingEnvOffered = useMemo(() => {
		if (!envs) return false;
		return codingToolsEnvWouldOffer({
			botSetting: bot.toolsEnv ?? null,
			accountDefaultEnvId: defaultEnvId,
			envKindById: Object.fromEntries(envs.map((env) => [env.envId, env.kind])),
		});
	}, [bot.toolsEnv, defaultEnvId, envs]);

	const catalog = availableAllowlistCatalog(codingEnvOffered, bot.model);
	const available = availableAllowlistNames(codingEnvOffered, bot.model);
	const count = allowlistCount(selected, codingEnvOffered, bot.model);
	const readonlyNames = knownReadOnlyToolNames(available);

	useEffect(() => {
		let cancelled = false;
		const gen = ++envGen.current;
		void loadAttempt;
		void envKey;
		setLoadError(null);
		void client
			.callRpc<{
				envs?: ToolsEnvRecord[];
				default?: { envId?: string } | null;
			}>("account.toolsEnvs.list")
			.then((res) => {
				if (cancelled || gen !== envGen.current) return;
				if (!res.ok) {
					setLoadError(
						res.error?.message ?? "Could not load tools environments",
					);
					return;
				}
				const listed = res.result?.envs ?? [];
				const accountDefault = res.result?.default?.envId ?? null;
				setEnvs(listed);
				setDefaultEnvId(accountDefault);
				const offered = codingToolsEnvWouldOffer({
					botSetting: toolsEnvRef.current ?? null,
					accountDefaultEnvId: accountDefault,
					envKindById: Object.fromEntries(
						listed.map((env) => [env.envId, env.kind]),
					),
				});
				const names = availableAllowlistNames(offered, bot.model);
				const next = displayedAllowlist({
					stored: storedToolsRef.current,
					available: names,
					codingEnvOffered: offered,
					model: bot.model,
				});
				setSelected(next);
				const readonly = knownReadOnlyToolNames(names);
				const matchesReadonly =
					readonly.length > 0 && sameToolSet(next, readonly);
				setReadOnlyOn(matchesReadonly);
				preReadOnly.current = null;
			})
			.catch((err: unknown) => {
				if (!cancelled && gen === envGen.current) {
					setLoadError(
						err instanceof Error
							? err.message
							: "Could not load tools environments",
					);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [envKey, client, loadAttempt, bot.model]);

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
			codingEnvOffered,
			model: bot.model,
		});
	}

	if (loadError) {
		return (
			<LoadError
				message={loadError}
				onRetry={() => setLoadAttempt((n) => n + 1)}
			/>
		);
	}
	if (!envs) {
		return <SkeletonBlock label="Loading tools" />;
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
							codingEnvOffered,
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
