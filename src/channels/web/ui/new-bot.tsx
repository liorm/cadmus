import { useEffect, useState } from "preact/hooks";
import { DEFAULT_SOUL } from "../../../extensions/default-soul.ts";
import { FILE_TOOLS, WEB_TOOLS } from "../../bot-catalog.ts";
import { slugifyBotName } from "../../bot-slug.ts";
import {
	createBot,
	loadModels,
	readBotText,
	setTelegramToken,
	updateBot,
	writeBotText,
} from "./client.ts";
import { modal, selectedBot } from "./state.ts";

const LEVELS = ["off", "low", "medium", "high"] as const;

type Provider = { id: string; models: string[] };

function modelChoices(
	providers: Provider[],
	provider: string,
	modelId: string,
): { provider: string; modelId: string }[] {
	const rows = providers.flatMap((item) =>
		item.models.map((id) => ({ provider: item.id, modelId: id })),
	);
	if (
		provider &&
		modelId &&
		!rows.some((row) => row.provider === provider && row.modelId === modelId)
	) {
		rows.push({ provider, modelId });
	}
	rows.sort(
		(a, b) =>
			a.provider.localeCompare(b.provider) ||
			a.modelId.localeCompare(b.modelId),
	);
	return rows;
}

function splitModel(ref: string): { provider: string; modelId: string } {
	const slash = ref.indexOf("/");
	if (slash <= 0) return { provider: "", modelId: ref };
	return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

export function BotDialog() {
	const editing = modal.value === "edit";
	const current = selectedBot();
	const initial = splitModel(current?.model ?? "");
	const [name, setName] = useState(editing ? (current?.name ?? "") : "");
	const [providers, setProviders] = useState<Provider[]>([]);
	const [provider, setProvider] = useState(initial.provider);
	const [modelId, setModelId] = useState(initial.modelId);
	const [thinking, setThinking] = useState<(typeof LEVELS)[number] | string>(
		LEVELS.find((level) => level === current?.thinking) ??
			(editing ? (current?.thinking ?? "medium") : "medium"),
	);
	const [web, setWeb] = useState<Set<string>>(
		new Set(
			(current?.tools ?? []).filter((tool) =>
				(WEB_TOOLS as readonly string[]).includes(tool),
			),
		),
	);
	const [token, setToken] = useState("");
	const [soul, setSoul] = useState(editing ? "" : `${DEFAULT_SOUL}\n`);
	const [soulReady, setSoulReady] = useState(!editing);
	const [error, setError] = useState("");
	const [modelsOpen, setModelsOpen] = useState(false);
	const slug = editing ? current?.id : slugifyBotName(name);
	const choices = modelChoices(providers, provider, modelId);

	useEffect(() => {
		let cancel = false;
		void loadModels()
			.then((next) => {
				if (cancel) return;
				setProviders(next);
				if (!editing) {
					const preferred = next.find((item) => item.id === initial.provider);
					const fallback = preferred ?? next[0];
					if (!fallback) return;
					setProvider(fallback.id);
					const keep = fallback.models.includes(initial.modelId)
						? initial.modelId
						: fallback.models[0];
					if (keep) setModelId(keep);
				}
			})
			.catch((caught: Error) => setError(caught.message));
		if (editing) {
			void readBotText("SOUL.md")
				.then((text) => {
					if (cancel) return;
					setSoul(text);
					setSoulReady(true);
				})
				.catch((caught: Error) => setError(caught.message));
		}
		return () => {
			cancel = true;
		};
	}, [editing, initial.provider, initial.modelId]);

	const submit = () => {
		const tools = WEB_TOOLS.filter((tool) => web.has(tool));
		const model = `${provider}/${modelId}`;
		const done = editing
			? updateBot({ name, model, thinking, tools })
					.then(() => writeBotText("SOUL.md", soul))
					.then(() =>
						token.trim() ? setTelegramToken(token.trim()) : undefined,
					)
			: createBot({
					name,
					model,
					thinking,
					tools,
					soul,
					...(token.trim() ? { token: token.trim() } : {}),
				});
		void done
			.then(() => (modal.value = null))
			.catch((caught: Error) => setError(caught.message));
	};

	return (
		<div class="ov">
			<div class="mod">
				<div style="padding:18px 22px 4px;font-size:18px;font-weight:700">
					{editing ? (current?.name ?? "Bot") : "New bot"}
				</div>
				<div class="mu" style="padding:0 22px 14px;font-size:13px">
					A folder with its own persona, rules and knowledge. Chats started
					under it stay with it.
				</div>
				<div class="dialog-body">
					<div class="f">
						<label>
							Name
							<input
								class="inp on"
								value={name}
								onInput={(event) =>
									setName((event.currentTarget as HTMLInputElement).value)
								}
							/>
						</label>
						<div class="key" style="margin-top:4px">
							slug <span class="ac">{slug ?? "—"}</span>
							{editing ? (
								<span> · renaming the folder is not available here</span>
							) : (
								<span> · chats will be keyed {slug ?? "…"}:web:…</span>
							)}
						</div>
					</div>
					<div class="f">
						<div class="lab">Model</div>
						<div class="model-pick">
							<button
								type="button"
								class="inp model-row"
								onClick={() => setModelsOpen((open) => !open)}
							>
								<span>{provider}</span>
								<span>{modelId}</span>
							</button>
							{modelsOpen ? (
								<div class="model-list">
									{choices.map((choice) => (
										<button
											type="button"
											key={`${choice.provider}/${choice.modelId}`}
											class={
												choice.provider === provider &&
												choice.modelId === modelId
													? "on"
													: ""
											}
											onClick={() => {
												setProvider(choice.provider);
												setModelId(choice.modelId);
												setModelsOpen(false);
											}}
										>
											<span>{choice.provider}</span>
											<span>{choice.modelId}</span>
										</button>
									))}
								</div>
							) : null}
						</div>
					</div>
					<div class="f">
						<div class="lab">Thinking</div>
						<div class="seg">
							{(LEVELS.includes(thinking as (typeof LEVELS)[number])
								? LEVELS
								: [...LEVELS, thinking]
							).map((level) => (
								<button
									type="button"
									key={level}
									class={thinking === level ? "on" : ""}
									onClick={() => setThinking(level)}
								>
									{level || "default"}
								</button>
							))}
						</div>
					</div>
					<div class="f">
						<div class="lab">Tools</div>
						<div class="tool-group">
							<div class="mu">Files</div>
							{FILE_TOOLS.map((tool) => (
								<div key={tool}>
									<span class="tick on">✓</span>
									{tool}
								</div>
							))}
						</div>
						<div class="tool-group">
							<div class="mu">Web</div>
							{WEB_TOOLS.map((tool) => (
								<label key={tool}>
									<input
										type="checkbox"
										checked={web.has(tool)}
										onChange={(event) => {
											const on = (event.currentTarget as HTMLInputElement)
												.checked;
											setWeb((prev) => {
												const next = new Set(prev);
												if (on) next.add(tool);
												else next.delete(tool);
												return next;
											});
										}}
									/>{" "}
									{tool}
								</label>
							))}
						</div>
					</div>
					<div class="f">
						<label>
							Telegram token
							<input
								class="inp"
								type="password"
								autocomplete="off"
								placeholder={
									editing && current?.telegramConfigured
										? "Configured"
										: "Not configured"
								}
								value={token}
								onInput={(event) =>
									setToken((event.currentTarget as HTMLInputElement).value)
								}
							/>
						</label>
						{editing ? (
							<div class="actions">
								<button
									type="button"
									class="btn ghost"
									onClick={() =>
										void setTelegramToken(null)
											.then(() => setToken(""))
											.catch((caught: Error) => setError(caught.message))
									}
								>
									Clear
								</button>
							</div>
						) : null}
					</div>
					<div class="f">
						<label>
							SOUL.md
							<textarea
								class="inp soul"
								value={soul}
								spellcheck={false}
								onInput={(event) =>
									setSoul((event.currentTarget as HTMLTextAreaElement).value)
								}
							/>
						</label>
					</div>
				</div>
				{error ? (
					<div class="errbox" style="margin:0 22px 12px">
						{error}
					</div>
				) : null}
				<div style="display:flex;justify-content:flex-end;gap:10px;padding:14px 22px;border-top:1px solid var(--line)">
					<button
						type="button"
						class="btn ghost"
						onClick={() => (modal.value = null)}
					>
						Cancel
					</button>
					<button
						type="button"
						class="btn pri"
						disabled={!provider || !modelId || !soulReady}
						onClick={submit}
					>
						{editing ? "Save" : "Create bot"}
					</button>
				</div>
			</div>
		</div>
	);
}
