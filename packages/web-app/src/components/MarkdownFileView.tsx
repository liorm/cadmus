import { useBlocker } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Markdown } from "@/components/Markdown";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useCadmus } from "@/context/CadmusContext";

export function MarkdownFileView({
	botId,
	path,
	title,
	onDelete,
}: {
	botId: string;
	path: string;
	title: string;
	onDelete?: () => void;
}) {
	const { client } = useCadmus();
	const [content, setContent] = useState("");
	const [draft, setDraft] = useState("");
	const [version, setVersion] = useState<number | undefined>();
	const [editing, setEditing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const dirty = editing && draft !== content;

	useEffect(() => {
		let cancelled = false;
		void client
			.callRpc<{ content?: string; text?: string; version?: number }>(
				"file.read",
				{ botId, path },
			)
			.then((res) => {
				if (cancelled || !res.ok || !res.result) return;
				const text = res.result.content ?? res.result.text ?? "";
				setContent(text);
				setDraft(text);
				setVersion(res.result.version);
			});
		return () => {
			cancelled = true;
		};
	}, [botId, client, path]);

	useEffect(() => {
		if (!dirty) return;
		const onBefore = (event: BeforeUnloadEvent) => {
			event.preventDefault();
		};
		window.addEventListener("beforeunload", onBefore);
		return () => window.removeEventListener("beforeunload", onBefore);
	}, [dirty]);

	useBlocker({
		shouldBlockFn: () => dirty && !window.confirm("Discard unsaved changes?"),
		withResolver: false,
	});

	async function save() {
		setError(null);
		const res = await client.callRpc<{ version?: number }>("file.write", {
			botId,
			path,
			content: draft,
			...(version !== undefined ? { expectedVersion: version } : {}),
		});
		if (!res.ok) {
			setError(res.error?.message ?? "Save failed");
			return;
		}
		setContent(draft);
		if (res.result?.version !== undefined) setVersion(res.result.version);
		setEditing(false);
	}

	function requestLeave(next: () => void) {
		if (dirty && !window.confirm("Discard unsaved changes?")) return;
		next();
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex min-h-tap items-center justify-end gap-2 px-3">
				{dirty ? (
					<span className="mr-auto text-[length:var(--fs-sm)] text-status-needs-you">
						Unsaved changes
					</span>
				) : (
					<span className="mr-auto text-[length:var(--fs-sm)] text-text-muted">
						{title}
					</span>
				)}
				{onDelete ? (
					<Button
						variant="ghost"
						aria-label={`Delete ${title}`}
						onClick={() => {
							if (dirty && !window.confirm("Discard unsaved changes?")) return;
							onDelete();
						}}
					>
						Delete
					</Button>
				) : null}
				{editing ? (
					<>
						<Button
							variant="outlined"
							onClick={() =>
								requestLeave(() => {
									setDraft(content);
									setEditing(false);
								})
							}
						>
							Cancel
						</Button>
						<Button onClick={() => void save()}>Save</Button>
					</>
				) : (
					<Button
						variant="outlined"
						aria-label="Edit"
						onClick={() => setEditing(true)}
					>
						✎ Edit
					</Button>
				)}
			</div>
			{error ? (
				<p
					role="alert"
					className="px-3 text-[length:var(--fs-sm)] text-status-failed"
				>
					{error}
				</p>
			) : null}
			{editing ? (
				<Textarea
					aria-label={`${title} source`}
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					className="m-3 min-h-0 flex-1 font-mono"
				/>
			) : (
				<div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
					<Markdown source={content || "_Empty._"} />
				</div>
			)}
		</div>
	);
}
