import { loadFiles, openFile, saveFile } from "./client.ts";
import { banner, filePath, files, fileText, saved, showList } from "./state.ts";

function descriptionOf(text: string): { description?: string; error?: string } {
	const match = /^---\r?\ndescription:[ \t]*([^\r\n]*)\r?\n---(?:\r?\n|$)/.exec(
		text,
	);
	if (!match)
		return {
			error: "description is required, one line, at most 240 characters.",
		};
	const description = (match[1] ?? "").trim();
	if (!description) return { error: "description is empty." };
	if (description.length > 240)
		return {
			error: `description is ${description.length} characters — max 240, one line.`,
		};
	return { description };
}

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
	const checked = knowledge ? descriptionOf(fileText.value) : {};
	const slug = path?.startsWith("knowledge/")
		? path.slice("knowledge/".length, -3)
		: "";
	const badSlug = knowledge && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug);
	const error = badSlug ? "The file name is not a legal slug." : checked.error;
	const count = checked.description?.length;
	return (
		<main class="main">
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
						onClick={() => void save().catch(show)}
					>
						Save
					</button>
				</div>
			</div>
			<div class="pg">
				{error ? (
					<div class="errbox">
						Can't save: <b>{error}</b> The file was not changed.
					</div>
				) : null}
				<div class={`panel ed ${error ? "bad" : ""}`}>
					<div class="gutter">
						{fileText.value.split("\n").map((_, index) => (
							<i key={index} class={error && index === 1 ? "bad" : ""}>
								{index + 1}
							</i>
						))}
					</div>
					<textarea
						class="src"
						value={fileText.value}
						spellcheck={false}
						onInput={(event) =>
							(fileText.value = (
								event.currentTarget as HTMLTextAreaElement
							).value)
						}
					/>
				</div>
				<div class="mu filemeta">
					{knowledge ? (
						<span class={error ? "err" : ""}>description {count ?? 0}/240</span>
					) : (
						<span>SOUL.md has no description</span>
					)}
					<span>
						index line:{" "}
						<span class="mono">
							{path
								? `${path}${checked.description ? ` — ${checked.description}` : ""}`
								: ""}
						</span>
					</span>
					{saved.value ? <span class="ok">{saved.value}</span> : null}
				</div>
			</div>
		</main>
	);
}

function openPane(): void {
	showList.value = false;
}

async function createFile() {
	const slug = window.prompt("Knowledge slug", "notes");
	if (!slug) return;
	if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
		banner.value = "The file name is not a legal slug.";
		return;
	}
	const path = `knowledge/${slug}.md`;
	const text = "---\ndescription: \n---\n\n";
	filePath.value = path;
	fileText.value = text;
	showList.value = false;
}

async function save() {
	const path = filePath.value;
	if (!path) return;
	await saveFile(path, fileText.value);
	banner.value = "";
	saved.value = "Knowledge updated";
}

function show(error: Error) {
	banner.value = error.message;
}

export function ensureFiles(): void {
	if (files.value.length === 0) void loadFiles().catch(show);
}
