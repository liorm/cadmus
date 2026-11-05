import { useBlocker } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { Markdown } from "@/components/Markdown";
import { LoadGate } from "@/components/Skeleton";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useCadmus } from "@/context/CadmusContext";
import { useScopedResource } from "@/hooks/useScopedResource";

type EditorState = {
	scope: string;
	baseline: string;
	draft: string;
	version: number | undefined;
	editing: boolean;
	error: string | null;
};

function blankEditor(scope: string): EditorState {
	return {
		scope,
		baseline: "",
		draft: "",
		version: undefined,
		editing: false,
		error: null,
	};
}

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
	const scope = `${botId}:${path}`;
	const loaded = useScopedResource(scope, async () => {
		const res = await client.callRpc<{
			content?: string;
			text?: string;
			version?: number;
		}>("file.read", { botId, path });
		if (!res.ok) throw new Error(res.error?.message ?? "Could not load file");
		return {
			text: res.result?.content ?? res.result?.text ?? "",
			version: res.result?.version,
		};
	});
	const [editor, setEditor] = useState<EditorState>(() => blankEditor(scope));
	let view = editor.scope === scope ? editor : blankEditor(scope);
	const loadedText =
		loaded.phase === "ready" && loaded.data ? loaded.data.text : undefined;
	const loadedVersion = loaded.data?.version;
	const hasRealEdits = view.editing && view.draft !== view.baseline;
	if (
		loadedText !== undefined &&
		!hasRealEdits &&
		(view.baseline !== loadedText ||
			view.draft !== loadedText ||
			view.version !== loadedVersion)
	) {
		view = {
			...view,
			scope,
			baseline: loadedText,
			draft: loadedText,
			version: loadedVersion,
		};
	}
	if (view !== editor) setEditor(view);
	const dirty = hasRealEdits;
	const dirtyRef = useRef(dirty);
	dirtyRef.current = dirty;

	useBlocker({
		shouldBlockFn: () =>
			dirtyRef.current && !window.confirm("Discard unsaved changes?"),
		enableBeforeUnload: () => dirtyRef.current,
		withResolver: false,
	});

	async function save() {
		const draft = view.draft;
		const res = await client.callRpc<{ version?: number }>("file.write", {
			botId,
			path,
			content: draft,
			...(view.version !== undefined ? { expectedVersion: view.version } : {}),
		});
		if (!res.ok) {
			const message = res.error?.message ?? "Save failed";
			setEditor((prev) =>
				prev.scope !== scope ? prev : { ...prev, error: message },
			);
			return;
		}
		const version = res.result?.version ?? view.version;
		setEditor((prev) =>
			prev.scope !== scope
				? prev
				: {
						...prev,
						baseline: draft,
						draft,
						version,
						editing: false,
						error: null,
					},
		);
		loaded.retry();
	}

	function requestLeave(next: () => void) {
		if (dirty && !window.confirm("Discard unsaved changes?")) return;
		next();
	}

	function beginEdit() {
		setEditor((prev) =>
			prev.scope !== scope
				? prev
				: { ...prev, editing: true, draft: prev.baseline, error: null },
		);
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
				{loaded.phase !== "ready" ? null : view.editing ? (
					<>
						<Button
							variant="outlined"
							onClick={() =>
								requestLeave(() => {
									setEditor((prev) =>
										prev.scope !== scope
											? prev
											: {
													...prev,
													draft: prev.baseline,
													editing: false,
													error: null,
												},
									);
								})
							}
						>
							Cancel
						</Button>
						<Button onClick={() => void save()}>Save</Button>
					</>
				) : (
					<Button variant="outlined" aria-label="Edit" onClick={beginEdit}>
						✎ Edit
					</Button>
				)}
			</div>
			{view.error ? (
				<p
					role="alert"
					className="px-3 text-[length:var(--fs-sm)] text-status-failed"
				>
					{view.error}
				</p>
			) : null}
			<LoadGate
				phase={loaded.phase}
				error={loaded.error}
				onRetry={loaded.retry}
				label={`Loading ${title}`}
			>
				{view.editing ? (
					<Textarea
						aria-label={`${title} source`}
						value={view.draft}
						onChange={(event) => {
							const next = event.target.value;
							setEditor((prev) =>
								prev.scope !== scope ? prev : { ...prev, draft: next },
							);
						}}
						disabled={loaded.phase !== "ready"}
						className="m-3 min-h-0 flex-1 font-mono"
					/>
				) : (
					<div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
						<Markdown source={view.baseline || "_Empty._"} />
					</div>
				)}
			</LoadGate>
		</div>
	);
}
