import type { BotRecord } from "@cadmus/contract/types";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { LoadError, SkeletonBlock } from "@/components/Skeleton";
import { ToolAllowlist } from "@/components/ToolAllowlist";
import { useCadmus } from "@/context/CadmusContext";

export function ToolsPage({ botId }: { botId: string }) {
	const { client, refreshDirectory } = useCadmus();
	const [bot, setBot] = useState<BotRecord | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		let cancelled = false;
		void attempt;
		setBot(null);
		setError(null);
		void client
			.callRpc<{ bot?: BotRecord }>("bot.get", { botId })
			.then((res) => {
				if (cancelled) return;
				if (!res.ok || !res.result?.bot) {
					setError(res.error?.message ?? "Could not load tools");
					return;
				}
				setBot(res.result.bot);
			})
			.catch((err: unknown) => {
				if (!cancelled)
					setError(err instanceof Error ? err.message : "Could not load tools");
			});
		return () => {
			cancelled = true;
		};
	}, [attempt, botId, client]);

	return (
		<AppShell title="Tool allowlist" backTo={`/bot/${botId}/config`}>
			{bot ? (
				<ToolAllowlist
					bot={bot}
					onSaved={async () => {
						const res = await client.callRpc<{ bot?: BotRecord }>("bot.get", {
							botId,
						});
						if (res.result?.bot) setBot(res.result.bot);
						await refreshDirectory();
					}}
				/>
			) : error ? (
				<LoadError
					message={error}
					onRetry={() => setAttempt((value) => value + 1)}
				/>
			) : (
				<SkeletonBlock label="Loading tools" />
			)}
		</AppShell>
	);
}
