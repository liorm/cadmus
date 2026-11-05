import { useNavigate } from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";
import { MarkdownFileView } from "@/components/MarkdownFileView";
import { useCadmus } from "@/context/CadmusContext";

export function DocPage({ botId, path }: { botId: string; path: string }) {
	const navigate = useNavigate();
	const { client } = useCadmus();
	const title = path.split("/").pop() ?? path;
	return (
		<AppShell title={title} backTo={`/bot/${botId}/knowledge`}>
			<MarkdownFileView
				botId={botId}
				path={path}
				title={title}
				onDelete={() => {
					void client.callRpc("file.delete", { botId, path }).then(() =>
						navigate({
							to: "/bot/$botId/$tab",
							params: { botId, tab: "knowledge" },
						}),
					);
				}}
			/>
		</AppShell>
	);
}
