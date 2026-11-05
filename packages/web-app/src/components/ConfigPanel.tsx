import type {
	BotRecord,
	ToolsEnvRecord,
	ToolsEnvSetting,
} from "@cadmus/contract/types";
import { useEffect, useState } from "react";
import { BottomSheet } from "@/components/BottomSheet";
import { ColorSwatches } from "@/components/ColorSwatches";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Button } from "@/components/ui/button";
import { useCadmus } from "@/context/CadmusContext";
import { allowlistCount } from "@/lib/allowlist-count";
import { type BotPaletteSlot, botColor } from "@/lib/bot-color";
import { toolsEnvLabel } from "@/lib/tools-env-label";

const THINKING = [
	{ value: "off", label: "Off" },
	{ value: "minimal", label: "Minimal" },
	{ value: "low", label: "Low" },
	{ value: "medium", label: "Medium" },
	{ value: "high", label: "High" },
] as const;

function timeZones(current: string): string[] {
	const base =
		typeof Intl !== "undefined" && "supportedValuesOf" in Intl
			? Intl.supportedValuesOf("timeZone")
			: ["UTC", "Asia/Jerusalem", "America/New_York", "Europe/London"];
	return base.includes(current) ? base : [current, ...base];
}

export function ConfigPanel({
	bot,
	noteCount,
	onOpenTools,
	onOpenHarvest,
	onChanged,
	onDeleted,
}: {
	bot: BotRecord;
	noteCount: number;
	onOpenTools: () => void;
	onOpenHarvest: () => void;
	onChanged: () => Promise<void>;
	onDeleted: () => void;
}) {
	const { client } = useCadmus();
	const [models, setModels] = useState<string[]>([bot.model]);
	const [envs, setEnvs] = useState<ToolsEnvRecord[]>([]);
	const [envOpen, setEnvOpen] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const slot = botColor(bot);
	const envNames = Object.fromEntries(
		envs.map((env) => [env.envId, env.label?.trim() || env.envId]),
	);
	const count = allowlistCount(bot.tools);

	useEffect(() => {
		let cancelled = false;
		void client
			.callRpc<{ models?: Array<{ id: string }> }>("account.models.list")
			.then((res) => {
				if (cancelled || !res.ok) return;
				const ids = (res.result?.models ?? []).map((model) => model.id);
				setModels(ids.includes(bot.model) ? ids : [bot.model, ...ids]);
			});
		void client
			.callRpc<{ envs?: ToolsEnvRecord[] }>("account.toolsEnvs.list")
			.then((res) => {
				if (cancelled || !res.ok) return;
				setEnvs(res.result?.envs ?? []);
			});
		return () => {
			cancelled = true;
		};
	}, [bot.model, client]);

	async function patch(payload: Record<string, unknown>) {
		await client.callRpc("bot.update", { botId: bot.id, ...payload });
		await onChanged();
	}

	async function setToolsEnv(toolsEnv: ToolsEnvSetting) {
		await patch({ toolsEnv });
		setEnvOpen(false);
	}

	return (
		<div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
			<section className="mb-4">
				<h2 className="mb-2 text-[length:var(--fs-xs)] font-semibold uppercase tracking-wide text-text-muted">
					Model
				</h2>
				<label className="block rounded-md border border-border bg-surface px-3 py-2">
					<span className="sr-only">Model</span>
					<select
						aria-label="Model"
						value={bot.model}
						onChange={(event) => void patch({ model: event.target.value })}
						className="w-full bg-transparent text-[length:var(--fs-md)] font-semibold"
					>
						{models.map((id) => (
							<option key={id} value={id}>
								{id}
							</option>
						))}
					</select>
					<span className="text-[length:var(--fs-sm)] text-text-muted">
						Model used for this bot
					</span>
				</label>
			</section>
			<section className="mb-4">
				<h2 className="mb-2 text-[length:var(--fs-xs)] font-semibold uppercase tracking-wide text-text-muted">
					Thinking level
				</h2>
				<SegmentedControl
					ariaLabel="Thinking level"
					scroll
					value={bot.thinking}
					onValueChange={(thinking) => void patch({ thinking })}
					options={THINKING}
				/>
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
						onClick={() => setEnvOpen(true)}
					>
						<span className="font-semibold">Tools environment</span>
						<span className="text-[length:var(--fs-sm)] text-text-muted">
							{toolsEnvLabel(bot.toolsEnv, envNames)}
						</span>
					</button>
				</div>
			</section>
			<section className="mb-4">
				<h2 className="mb-2 text-[length:var(--fs-xs)] font-semibold uppercase tracking-wide text-text-muted">
					General
				</h2>
				<div className="overflow-hidden rounded-md border border-border bg-surface">
					<label className="flex flex-col border-b border-border px-3 py-2">
						<span className="font-semibold">Timezone</span>
						<select
							aria-label="Timezone"
							value={bot.timezone}
							onChange={(event) => void patch({ timezone: event.target.value })}
							className="bg-transparent text-[length:var(--fs-sm)] text-text-muted"
						>
							{timeZones(bot.timezone).map((zone) => (
								<option key={zone} value={zone}>
									{zone}
								</option>
							))}
						</select>
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
					<button
						type="button"
						className="flex min-h-tap w-full flex-col px-3 py-2 text-left"
						onClick={onOpenHarvest}
					>
						<span className="font-semibold">Harvest</span>
						<span className="text-[length:var(--fs-sm)] text-text-muted">
							{noteCount} {noteCount === 1 ? "note" : "notes"}
						</span>
					</button>
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
