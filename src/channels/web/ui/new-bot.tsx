import { useEffect, useRef, useState } from "preact/hooks";
import { DEFAULT_SOUL } from "../../../extensions/default-soul.ts";
import { slugifyBotName } from "../../bot-slug.ts";
import {
	createBot,
	loadModels,
	loadToolCatalog,
	readBotText,
	setTelegramToken,
	updateBot,
	writeBotText,
} from "./client.ts";
import { modal, selectedBot } from "./state.ts";

const LEVELS = ["", "off", "low", "medium", "high"] as const;

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

function toggleTool(prev: Set<string>, tool: string): Set<string> {
	const next = new Set(prev);
	if (next.has(tool)) next.delete(tool);
	else next.add(tool);
	return next;
}

function ToolGroup({
	title,
	names,
	selected,
	onToggle,
	onAll,
}: {
	title: string;
	names: readonly string[];
	selected: Set<string>;
	onToggle: (tool: string) => void;
	onAll: (on: boolean) => void;
}) {
	const allOn = names.every((tool) => selected.has(tool));
	return (
		<div class="tool-card">
			<div class="tool-head">
				<div class="sec">{title}</div>
				<button
					type="button"
					class={allOn ? "tool-all on" : "tool-all"}
					aria-pressed={allOn}
					onClick={() => onAll(!allOn)}
				>
					All
				</button>
			</div>
			{names.map((tool) => {
				const on = selected.has(tool);
				return (
					<button
						type="button"
						key={tool}
						class={on ? "tool-row on" : "tool-row"}
						aria-pressed={on}
						onClick={() => onToggle(tool)}
					>
						<span class={on ? "tick on" : "tick"}>{on ? "✓" : ""}</span>
						<span class="mono">{tool}</span>
					</button>
				);
			})}
		</div>
	);
}

type FormSnap = {
	name: string;
	provider: string;
	modelId: string;
	thinking: string;
	tools: string;
	token: string;
	soul: string;
};

function toolKey(names: Iterable<string>): string {
	return [...names].sort().join("\n");
}

function initialThinking(
	editing: boolean,
	current: { thinking?: string } | undefined,
): string {
	if (!editing) return "";
	const stored = current?.thinking;
	if ((LEVELS as readonly string[]).includes(stored ?? "\0"))
		return stored ?? "";
	return stored ?? "medium";
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
	const [thinking, setThinking] = useState(initialThinking(editing, current));
	const [catalog, setCatalog] = useState<{ group: string; name: string }[]>([]);
	const catalogNames = useRef<string[]>([]);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [token, setToken] = useState("");
	const [soul, setSoul] = useState(editing ? "" : `${DEFAULT_SOUL}\n`);
	const [soulReady, setSoulReady] = useState(!editing);
	const [error, setError] = useState("");
	const [confirmClose, setConfirmClose] = useState(false);
	const [baseline, setBaseline] = useState<FormSnap | null>(null);
	const [modelsOpen, setModelsOpen] = useState(false);
	const [menuBox, setMenuBox] = useState({ top: 0, left: 0, width: 0 });
	const modelButton = useRef<HTMLButtonElement>(null);
	const modelMenu = useRef<HTMLDivElement>(null);
	const slug = editing ? current?.id : slugifyBotName(name);
	const choices = modelChoices(providers, provider, modelId);
	const dirty =
		baseline !== null &&
		(name !== baseline.name ||
			provider !== baseline.provider ||
			modelId !== baseline.modelId ||
			thinking !== baseline.thinking ||
			toolKey(selected) !== baseline.tools ||
			token !== baseline.token ||
			soul !== baseline.soul);

	const requestClose = () => {
		if (dirty) {
			setConfirmClose(true);
			return;
		}
		modal.value = null;
	};

	const placeModelMenu = () => {
		const rect = modelButton.current?.getBoundingClientRect();
		if (!rect) return;
		setMenuBox({ top: rect.bottom + 4, left: rect.left, width: rect.width });
	};

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
					const keep = fallback.models.includes(initial.modelId)
						? initial.modelId
						: (fallback.models[0] ?? "");
					setProvider(fallback.id);
					if (keep) setModelId(keep);
					setBaseline({
						name: "",
						provider: fallback.id,
						modelId: keep,
						thinking: initialThinking(false, current),
						tools: toolKey(catalogNames.current),
						token: "",
						soul: `${DEFAULT_SOUL}\n`,
					});
				}
			})
			.catch((caught: Error) => setError(caught.message));
		if (editing) {
			setBaseline({
				name: current?.name ?? "",
				provider: initial.provider,
				modelId: initial.modelId,
				thinking: initialThinking(true, current),
				tools: toolKey(catalogNames.current),
				token: "",
				soul: "",
			});
			void readBotText("SOUL.md")
				.then((text) => {
					if (cancel) return;
					setSoul(text);
					setBaseline((prev) => (prev ? { ...prev, soul: text } : prev));
					setSoulReady(true);
				})
				.catch((caught: Error) => setError(caught.message));
		}
		const stored = current?.tools;
		const picked = (names: string[]) =>
			stored === undefined
				? names
				: names.filter((name) => stored.includes(name));
		void loadToolCatalog()
			.then((items) => {
				if (cancel) return;
				const names = items.map((item) => item.name);
				catalogNames.current = names;
				const initialTools = picked(names);
				setCatalog(items);
				setSelected(new Set(initialTools));
				setBaseline((prev) =>
					prev ? { ...prev, tools: toolKey(initialTools) } : prev,
				);
			})
			.catch((caught: Error) => setError(caught.message));
		return () => {
			cancel = true;
		};
	}, [editing, initial.provider, initial.modelId]);

	useEffect(() => {
		if (!modelsOpen) return;
		placeModelMenu();
		const onPointer = (event: MouseEvent) => {
			const target = event.target as Node;
			if (modelButton.current?.contains(target)) return;
			if (modelMenu.current?.contains(target)) return;
			setModelsOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setModelsOpen(false);
		};
		document.addEventListener("mousedown", onPointer);
		document.addEventListener("keydown", onKey);
		window.addEventListener("resize", placeModelMenu);
		document.addEventListener("scroll", placeModelMenu, true);
		return () => {
			document.removeEventListener("mousedown", onPointer);
			document.removeEventListener("keydown", onKey);
			window.removeEventListener("resize", placeModelMenu);
			document.removeEventListener("scroll", placeModelMenu, true);
		};
	}, [modelsOpen]);

	const submit = () => {
		if (catalog.length === 0) {
			setError("Tools are still loading.");
			return;
		}
		const tools = catalog
			.map((tool) => tool.name)
			.filter((name) => selected.has(name));
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
			<button
				type="button"
				class="ov-dismiss"
				aria-label="Close"
				onClick={requestClose}
			/>
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
								ref={modelButton}
								aria-expanded={modelsOpen}
								aria-haspopup="listbox"
								onClick={() => {
									if (modelsOpen) {
										setModelsOpen(false);
										return;
									}
									placeModelMenu();
									setModelsOpen(true);
								}}
							>
								<span class="model-provider">{provider}</span>
								<span class="model-name">{modelId}</span>
							</button>
							{modelsOpen ? (
								<div
									class="model-list"
									ref={modelMenu}
									role="listbox"
									style={`top:${menuBox.top}px;left:${menuBox.left}px;width:${menuBox.width}px`}
								>
									{choices.map((choice) => (
										<button
											type="button"
											key={`${choice.provider}/${choice.modelId}`}
											role="option"
											aria-selected={
												choice.provider === provider &&
												choice.modelId === modelId
											}
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
											<span class="model-provider">{choice.provider}</span>
											<span class="model-name">{choice.modelId}</span>
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
									key={level || "default"}
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
						<div class="tools">
							{[...new Set(catalog.map((tool) => tool.group))].map((group) => {
								const names = catalog
									.filter((tool) => tool.group === group)
									.map((tool) => tool.name);
								return (
									<ToolGroup
										key={group}
										title={group}
										names={names}
										selected={selected}
										onToggle={(tool) =>
											setSelected((prev) => toggleTool(prev, tool))
										}
										onAll={(on) =>
											setSelected((prev) => {
												const next = new Set(prev);
												for (const name of names) {
													if (on) next.add(name);
													else next.delete(name);
												}
												return next;
											})
										}
									/>
								);
							})}
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
				<div style="display:flex;justify-content:flex-end;align-items:center;gap:10px;padding:14px 22px;border-top:1px solid var(--line)">
					{confirmClose ? (
						<span class="discard-ask">Discard unsaved changes?</span>
					) : null}
					<button
						type="button"
						class="btn ghost"
						onClick={() => {
							if (confirmClose) setConfirmClose(false);
							else modal.value = null;
						}}
					>
						{confirmClose ? "Keep editing" : "Cancel"}
					</button>
					{confirmClose ? (
						<button
							type="button"
							class="btn stop"
							onClick={() => (modal.value = null)}
						>
							Discard
						</button>
					) : (
						<button
							type="button"
							class="btn pri"
							disabled={!dirty || !provider || !modelId || !soulReady}
							onClick={submit}
						>
							{editing ? "Save" : "Create bot"}
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
