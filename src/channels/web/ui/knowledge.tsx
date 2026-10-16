import {
	emptyKnowledgeDraft,
	KNOWLEDGE_FIELDS,
	type KnowledgeDoc,
	knowledgeIndexLine,
	knowledgeWriteArgs,
	parseCategoryField,
	parseDescriptionField,
	parseKnowledgeWrite,
	parseSlug,
} from "../../../extensions/knowledge-parse.ts";
import { loadFiles, openFile, saveFile, saveKnowledge } from "./client.ts";
import {
	banner,
	filePath,
	files,
	fileText,
	knowledgeDraft,
	saved,
	showList,
} from "./state.ts";

export function KnowledgeList() {
	const path = filePath.value;
	return (
		<div class="list">
			<button type="button" class="btn ghost" onClick={() => void createFile()}>
				New file
			</button>
			{files.value.map((file) => (
				<button
					type="button"
					key={file.path}
					class={`kr ${file.path === path ? "sel" : ""}`}
					onClick={() => void openFile(file.path).then(openPane).catch(show)}
				>
					<span class="mono">{file.path.split("/").pop()}</span>
					{file.path.startsWith("knowledge/") ? (
						<span class={`d ${file.valid ? "" : "bad"}`}>
							{file.valid ? file.description : "unreadable frontmatter"}
						</span>
					) : null}
				</button>
			))}
		</div>
	);
}

export function Knowledge() {
	const path = filePath.value;
	const knowledge = path?.startsWith("knowledge/") ?? false;
	if (knowledge) return <KnowledgeEditor />;
	return <SoulEditor path={path} />;
}

function SoulEditor({ path }: { path: string | null }) {
	return (
		<main class="main">
			<EditorHeader path={path} error={undefined} onSave={saveSoul} />
			<div class="pg">
				<BodyEditor
					value={fileText.value}
					onInput={(value) => {
						fileText.value = value;
					}}
				/>
				<div class="mu filemeta">
					<span>SOUL.md has no description</span>
					{saved.value ? <span class="ok">{saved.value}</span> : null}
				</div>
			</div>
		</main>
	);
}

function KnowledgeEditor() {
	const draft = knowledgeDraft.value;
	const path = filePath.value;
	const parsed = draft
		? parseKnowledgeWrite(knowledgeWriteArgs(draft))
		: { ok: false as const, error: "No file selected." };
	const error = parsed.ok ? undefined : parsed.error;
	const index = draft ? previewIndex(draft) : (path ?? "");
	return (
		<main class="main">
			<EditorHeader path={path} error={error} onSave={saveDoc} />
			<div class="pg">
				{error ? (
					<div class="errbox">
						Can't save: <b>{error}</b>
					</div>
				) : null}
				<div class="kf">
					{KNOWLEDGE_FIELDS.map((field) => {
						if (!draft) return null;
						if (field.kind === "version") {
							return (
								<div class="f" key={field.name}>
									<label>
										{field.label}
										<input class="inp" value={String(draft.version)} readOnly />
									</label>
								</div>
							);
						}
						if (field.kind === "line") {
							const value = draft.lines[field.name] ?? "";
							return (
								<div class="f" key={field.name}>
									<label>
										{field.label}
										<input
											class="inp"
											value={value}
											spellcheck={field.name === "description"}
											onInput={(event) =>
												patchLine(
													field.name,
													(event.currentTarget as HTMLInputElement).value,
												)
											}
										/>
									</label>
									<div class={`mu ${error && field.required ? "err" : ""}`}>
										{value.trim().length}/{field.max}
									</div>
								</div>
							);
						}
						return (
							<div class="f span" key={field.name}>
								<div class="lab">{field.label}</div>
								<BodyEditor
									value={draft.body}
									onInput={(value) => patchBody(value)}
								/>
							</div>
						);
					})}
				</div>
				<div class="mu filemeta">
					<span>
						index line: <span class="mono">{index}</span>
					</span>
					{saved.value ? <span class="ok">{saved.value}</span> : null}
				</div>
			</div>
		</main>
	);
}

function EditorHeader({
	path,
	error,
	onSave,
}: {
	path: string | null;
	error: string | undefined;
	onSave: () => Promise<void>;
}) {
	return (
		<div class="hd">
			<button
				type="button"
				class="back"
				title="Files"
				onClick={() => (showList.value = true)}
			>
				‹
			</button>
			<div>
				<div class="t">{path ?? "Knowledge"}</div>
				<div class="key">knowledge index</div>
			</div>
			<div class="r">
				<button
					type="button"
					class="btn pri"
					disabled={Boolean(error)}
					onClick={() => void onSave().catch(show)}
				>
					Save
				</button>
			</div>
		</div>
	);
}

function BodyEditor({
	value,
	onInput,
}: {
	value: string;
	onInput: (value: string) => void;
}) {
	return (
		<div class="panel ed">
			<div class="gutter">
				{value.split("\n").map((_, index) => (
					<i key={index}>{index + 1}</i>
				))}
			</div>
			<textarea
				class="src"
				value={value}
				spellcheck={false}
				onInput={(event) =>
					onInput((event.currentTarget as HTMLTextAreaElement).value)
				}
			/>
		</div>
	);
}

function previewIndex(draft: {
	slug: string;
	version: number;
	body: string;
	lines: Record<string, string>;
}): string {
	const description = parseDescriptionField(draft.lines.description ?? "");
	if (!description) return `knowledge/${draft.slug}.md`;
	const category = parseCategoryField(draft.lines.category ?? "");
	const doc: KnowledgeDoc = {
		description,
		version: draft.version,
		body: draft.body,
		...(category === undefined ? {} : { category }),
	};
	return knowledgeIndexLine(`${draft.slug}.md`, doc);
}

function patchLine(name: string, value: string): void {
	const draft = knowledgeDraft.value;
	if (!draft) return;
	knowledgeDraft.value = {
		...draft,
		lines: { ...draft.lines, [name]: value },
	};
}

function patchBody(body: string): void {
	const draft = knowledgeDraft.value;
	if (!draft) return;
	knowledgeDraft.value = { ...draft, body };
}

function openPane(): void {
	showList.value = false;
}

async function createFile() {
	const slug = window.prompt("Knowledge slug", "notes");
	if (!slug) return;
	if (!parseSlug(slug, "knowledge")) {
		banner.value = "The file name is not a legal slug.";
		return;
	}
	filePath.value = `knowledge/${slug}.md`;
	fileText.value = "";
	knowledgeDraft.value = emptyKnowledgeDraft(slug);
	showList.value = false;
}

async function saveSoul() {
	const path = filePath.value;
	if (!path) return;
	await saveFile(path, fileText.value);
	banner.value = "";
	saved.value = "Knowledge updated";
}

async function saveDoc() {
	await saveKnowledge();
	banner.value = "";
	saved.value = "Knowledge updated";
}

function show(error: Error) {
	banner.value = error.message;
}

export function ensureFiles(): void {
	if (files.value.length === 0) void loadFiles().catch(show);
}
