import { codingToolsEnvWouldOffer } from "@cadmus/contract/tools";
import type {
	BotRecord,
	ModelInfo,
	ToolsEnvRecord,
	ToolsEnvSetting,
} from "@cadmus/contract/types";
import { useEffect, useState } from "react";
import { BottomSheet } from "@/components/BottomSheet";
import { ColorSwatches } from "@/components/ColorSwatches";
import { ModelSelect } from "@/components/ModelSelect";
import { SegmentedControl } from "@/components/SegmentedControl";
import { HintSkeleton, LoadError } from "@/components/Skeleton";
import { TimezoneCombobox } from "@/components/TimezoneCombobox";
import { Button } from "@/components/ui/button";
import { useCadmus } from "@/context/CadmusContext";
import { allowlistCount } from "@/lib/allowlist-count";
import { type BotPaletteSlot, botColor } from "@/lib/bot-color";
import type { LoadPhase } from "@/lib/load-state";
import {
	clampThinkingForModel,
	findModelByRef,
	getThinkingOptionsForModel,
} from "@/lib/thinking-levels";
import { toolsEnvLabel } from "@/lib/tools-env-label";

export function ConfigPanel({
	bot,
	noteCount,
	notesPhase,
	onRetryNotes,
	onOpenTools,
	onOpenHarvest,
	onChanged,
	onDeleted,
}: {
	bot: BotRecord;
	noteCount: number;
	notesPhase: LoadPhase;
	onRetryNotes: () => void;
	onOpenTools: () => void;
	onOpenHarvest: () => void;
	onChanged: () => Promise<void>;
	onDeleted: () => void;
}) {
	const { client } = useCadmus();
	const [models, setModels] = useState<ModelInfo[]>([]);
	const [modelsReady, setModelsReady] = useState(false);
	const [envs, setEnvs] = useState<ToolsEnvRecord[]>([]);
	const [defaultEnvId, setDefaultEnvId] = useState<string | null>(null);
	const [envsReady, setEnvsReady] = useState(false);
	const [configError, setConfigError] = useState<string | null>(null);
	const [configAttempt, setConfigAttempt] = useState(0);
	const [envOpen, setEnvOpen] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const slot = botColor(bot);
	const envNames = Object.fromEntries(
		envs.map((env) => [env.envId, env.label?.trim() || env.envId]),
	);
	const envKindById = Object.fromEntries(
		envs.map((env) => [env.envId, env.kind]),
	);
	const codingEnvOffered = codingToolsEnvWouldOffer({
		botSetting: bot.toolsEnv ?? null,
		accountDefaultEnvId: defaultEnvId,
		envKindById,
	});
	const count = allowlistCount(bot.tools, codingEnvOffered, bot.model);
	const selectedModel = modelsReady
		? findModelByRef(models, bot.model)
		: undefined;
	const thinkingOptions = getThinkingOptionsForModel(
		selectedModel,
		bot.thinking,
	);

	useEffect(() => {
		let cancelled = false;
		void configAttempt;
		setModelsReady(false);
		setEnvsReady(false);
		setConfigError(null);
		void client
			.callRpc<{ models?: ModelInfo[] }>("account.models.list")
			.then((res) => {
				if (cancelled) return;
				if (!res.ok) {
					setConfigError(res.error?.message ?? "Could not load models");
					return;
				}
				const listed = res.result?.models ?? [];
				setModels(listed);
				setModelsReady(true);
			})
			.catch((err: unknown) => {
				if (!cancelled) {
					setConfigError(
						err instanceof Error ? err.message : "Could not load models",
					);
				}
			});
		void client
			.callRpc<{
				envs?: ToolsEnvRecord[];
				default?: { envId?: string } | null;
			}>("account.toolsEnvs.list")
			.then((res) => {
				if (cancelled) return;
				if (!res.ok) {
					setConfigError(
						res.error?.message ?? "Could not load tools environments",
					);
					return;
				}
				setEnvs(res.result?.envs ?? []);
				setDefaultEnvId(res.result?.default?.envId ?? null);
				setEnvsReady(true);
			})
			.catch((err: unknown) => {
				if (!cancelled) {
					setConfigError(
						err instanceof Error
							? err.message
							: "Could not load tools environments",
					);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [client, configAttempt]);

	async function patch(payload: Record<string, unknown>) {
		const res = await client.callRpc("bot.update", {
			botId: bot.id,
			...payload,
		});
		if (!res.ok) {
			setConfigError(res.error?.message ?? "Could not save bot settings");
			return;
		}
		setConfigError(null);
		await onChanged();
	}

	async function setToolsEnv(toolsEnv: ToolsEnvSetting) {
		await patch({ toolsEnv });
		setEnvOpen(false);
	}

	return (
		<div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
			{configError ? (
				<LoadError
					message={configError}
					onRetry={() => setConfigAttempt((n) => n + 1)}
				/>
			) : null}
			<section className="mb-4">
				<h2 className="mb-2 text-[length:var(--fs-xs)] font-semibold uppercase tracking-wide text-text-muted">
					Model
				</h2>
				<div className="space-y-1.5 rounded-md border border-border bg-surface px-3 py-2">
					<ModelSelect
						ariaLabel="Model"
						disabled={!modelsReady}
						models={models}
						value={bot.model}
						onChange={(nextRef) => {
							const nextModel = findModelByRef(models, nextRef);
							const nextThinking = clampThinkingForModel(
								bot.thinking,
								nextModel,
							);
							void patch({
								model: nextRef,
								...(nextThinking !== bot.thinking
									? { thinking: nextThinking }
									: {}),
							});
						}}
					/>
					<span className="block text-[length:var(--fs-sm)] text-text-muted">
						Model used for this bot
					</span>
				</div>
			</section>
			<section className="mb-4">
				<h2 className="mb-2 text-[length:var(--fs-xs)] font-semibold uppercase tracking-wide text-text-muted">
					Thinking level
				</h2>
				{thinkingOptions.length > 0 ? (
					<SegmentedControl
						ariaLabel="Thinking level"
						scroll
						value={bot.thinking}
						onValueChange={(thinking) => void patch({ thinking })}
						options={thinkingOptions}
					/>
				) : (
					<p className="rounded-md border border-border bg-surface px-3 py-2 text-[length:var(--fs-sm)] text-text-muted">
						Selected model does not support thinking levels.
					</p>
				)}
			</section>
			<section className="mb-4">
				<h2 className="mb-2 text-[length:var(--fs-xs)] font-semibold uppercase tracking-wide text-text-muted">
					Tools
				</h2>
				<div className="overflow-hidden rounded-md border border-border bg-surface">
					<button
						type="button"
						className="flex min-h-tap w-full flex-col border-b border-border px-3 py-2 text-left"
						onClick={onOpenTools}
					>
						<span className="font-semibold">Tool allowlist</span>
						<span className="text-[length:var(--fs-sm)] text-text-muted">
							{count.label}
						</span>
					</button>
					<button
						type="button"
						className="flex min-h-tap w-full flex-col px-3 py-2 text-left"
						disabled={!envsReady}
						onClick={() => setEnvOpen(true)}
					>
						<span className="font-semibold">Tools environment</span>
						<span className="text-[length:var(--fs-sm)] text-text-muted">
							{envsReady ? (
								toolsEnvLabel(bot.toolsEnv, envNames)
							) : (
								<HintSkeleton />
							)}
						</span>
					</button>
				</div>
			</section>
			<section className="mb-4">
				<h2 className="mb-2 text-[length:var(--fs-xs)] font-semibold uppercase tracking-wide text-text-muted">
					General
				</h2>
				<div className="overflow-hidden rounded-md border border-border bg-surface">
					<label
						htmlFor="bot-timezone"
						className="flex flex-col border-b border-border px-3 py-2"
					>
						<span className="font-semibold">Timezone</span>
						<TimezoneCombobox
							id="bot-timezone"
							label="Timezone"
							value={bot.timezone}
							className="text-[length:var(--fs-sm)] text-text-muted"
							onChange={(timezone) => void patch({ timezone })}
						/>
					</label>
					<div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
						<div>
							<div className="font-semibold">Colour</div>
							<div className="text-[length:var(--fs-sm)] text-text-muted">
								{bot.metadata?.color
									? bot.metadata.color
									: "default from bot id"}
							</div>
						</div>
						<ColorSwatches
							value={slot}
							onChange={(next: BotPaletteSlot) =>
								void patch({ metadata: { color: `bot-${next}` } })
							}
						/>
					</div>
					<div className="flex min-h-tap w-full items-center justify-between px-3 py-2">
						<button
							type="button"
							className="flex min-w-0 flex-1 flex-col text-left"
							onClick={onOpenHarvest}
						>
							<span className="font-semibold">Harvest</span>
							<span className="text-[length:var(--fs-sm)] text-text-muted">
								{notesPhase === "ready" ? (
									`${noteCount} ${noteCount === 1 ? "note" : "notes"}`
								) : notesPhase === "loading" ? (
									<HintSkeleton />
								) : (
									"Failed to load notes"
								)}
							</span>
						</button>
						{notesPhase === "error" ? (
							<Button type="button" variant="ghost" onClick={onRetryNotes}>
								Retry
							</Button>
						) : null}
					</div>
				</div>
			</section>
			<Button
				variant="danger"
				className="w-full"
				onClick={() => setConfirmDelete(true)}
			>
				Delete bot
			</Button>
			<p className="mt-2 text-center text-[length:var(--fs-sm)] text-text-muted">
				Also deletes this bot's chats, files and schedules
			</p>
			<BottomSheet
				open={envOpen}
				onOpenChange={setEnvOpen}
				title="Tools environment"
			>
				<button
					type="button"
					className="flex min-h-tap w-full text-left"
					onClick={() => void setToolsEnv(null)}
				>
					Inherit
				</button>
				<button
					type="button"
					className="flex min-h-tap w-full text-left"
					onClick={() => void setToolsEnv({ enabled: false })}
				>
					Off
				</button>
				{envs.map((env) => (
					<button
						key={env.envId}
						type="button"
						className="flex min-h-tap w-full text-left"
						onClick={() =>
							void setToolsEnv({
								enabled: true,
								binding: { envId: env.envId },
							})
						}
					>
						On · {env.label?.trim() || env.envId}
					</button>
				))}
			</BottomSheet>
			<BottomSheet
				open={confirmDelete}
				onOpenChange={setConfirmDelete}
				title={`Delete ${bot.name}?`}
				description="This also deletes all of its chats, files and schedules. This can't be undone."
			>
				<Button
					variant="danger"
					onClick={() => {
						void client
							.callRpc("bot.delete", { botId: bot.id })
							.then(() => onDeleted());
					}}
				>
					Delete {bot.name}
				</Button>
			</BottomSheet>
		</div>
	);
}
