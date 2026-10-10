import { useState } from "preact/hooks";
import { slugifyBotName } from "../../bot-slug.ts";
import { createBot } from "./client.ts";
import { modal, selectedBot } from "./state.ts";

const LEVELS = ["off", "low", "medium", "high"] as const;

export function NewBot() {
	const current = selectedBot();
	const [name, setName] = useState("");
	const [model, setModel] = useState(current?.model ?? "");
	const [thinking, setThinking] = useState<(typeof LEVELS)[number]>(
		LEVELS.find((level) => level === current?.thinking) ?? "medium",
	);
	const [search, setSearch] = useState(true);
	const [fetchTool, setFetch] = useState(false);
	const [error, setError] = useState("");
	const slug = slugifyBotName(name);
	const submit = () => {
		const tools = [
			...(search ? ["web.search"] : []),
			...(fetchTool ? ["web.fetch"] : []),
		];
		void createBot({ name, model, thinking, tools })
			.then(() => (modal.value = false))
			.catch((caught: Error) => setError(caught.message));
	};
	return (
		<div class="ov">
			<div class="mod">
				<div style="padding:18px 22px 4px;font-size:18px;font-weight:700">
					New bot
				</div>
				<div class="mu" style="padding:0 22px 14px;font-size:13px">
					A folder with its own persona, rules and knowledge. Chats started
					under it stay with it.
				</div>
				<div style="display:grid;grid-template-columns:1fr 230px;gap:18px;padding:0 22px 16px">
					<div style="display:flex;flex-direction:column;gap:12px">
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
								slug <span class="ac">{slug ?? "—"}</span> · chats will be keyed{" "}
								{slug ?? "…"}:web:…
							</div>
						</div>
						<div class="f">
							<label>
								Model
								<input
									class="inp"
									value={model}
									onInput={(event) =>
										setModel((event.currentTarget as HTMLInputElement).value)
									}
								/>
							</label>
						</div>
						<div class="f">
							<div class="lab">Thinking</div>
							<div class="seg">
								{LEVELS.map((level) => (
									<button
										type="button"
										key={level}
										class={thinking === level ? "on" : ""}
										onClick={() => setThinking(level)}
									>
										{level}
									</button>
								))}
							</div>
						</div>
						<div class="f">
							<div class="lab">
								Tools <span class="tag">proposed</span>
							</div>
							<div style="font-size:13px;line-height:1.9">
								<span class="tick on">✓</span>read · write · edit{" "}
								<span class="mu">(bot folder only)</span>
								<br />
								<label>
									<input
										type="checkbox"
										checked={search}
										onChange={(event) =>
											setSearch(
												(event.currentTarget as HTMLInputElement).checked,
											)
										}
									/>{" "}
									web.search
								</label>
								<br />
								<label>
									<input
										type="checkbox"
										checked={fetchTool}
										onChange={(event) =>
											setFetch(
												(event.currentTarget as HTMLInputElement).checked,
											)
										}
									/>{" "}
									web.fetch
								</label>
							</div>
						</div>
					</div>
					<div>
						<div class="sec" style="margin-bottom:8px">
							Will create
						</div>
						<div class="tree">
							bots/<span class="ok">{slug ?? "…"}</span>/<br />
							├─ <span class="ok">SOUL.md</span> <span class="mu">default</span>
							<br />
							├─ <span class="ok">SYSTEM.md</span> <span class="mu">seed</span>
							<br />
							└─ <span class="ok">knowledge/</span>
						</div>
						<div class="mu" style="font-size:12px;margin-top:10px">
							Edit SOUL.md / SYSTEM.md after creating. Telegram stays on{" "}
							<span class="mono">default</span>.
						</div>
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
						onClick={() => (modal.value = false)}
					>
						Cancel
					</button>
					<button type="button" class="btn pri" onClick={submit}>
						Create bot
					</button>
				</div>
			</div>
		</div>
	);
}
