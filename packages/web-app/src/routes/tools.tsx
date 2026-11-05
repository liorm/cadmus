import type { BotRecord } from "@cadmus/contract/types";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { ToolAllowlist } from "@/components/ToolAllowlist";
import { useCadmus } from "@/context/CadmusContext";

export function ToolsPage({ botId }: { botId: string }) {
	const { client, refreshDirectory } = useCadmus();
	const [bot, setBot] = useState<BotRecord | null>(null);

	useEffect(() => {
		let cancelled = false;
		void client
			.callRpc<{ bot?: BotRecord }>("bot.get", { botId })
			.then((res) => {
				if (!cancelled && res.result?.bot) setBot(res.result.bot);
			});
		return () => {
			cancelled = true;
		};
	}, [botId, client]);

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
			) : (
				<p className="px-3 py-4 text-text-muted">Loading…</p>
			)}
		</AppShell>
	);
}
