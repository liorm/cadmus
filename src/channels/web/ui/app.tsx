import { useEffect, useRef, useState } from "preact/hooks";
import {
	createChat,
	deleteChat,
	openBot,
	renameChat,
	send,
	watchChat,
} from "./client.ts";
import { ensureFiles, Knowledge, KnowledgeList } from "./knowledge.tsx";
import { renderMarkdown } from "./markdown.ts";
import { BotDialog } from "./new-bot.tsx";
import { ensureSchedules, ScheduleList, Schedules } from "./schedules.tsx";
import {
	banner,
	botId,
	bots,
	busy,
	type Chat,
	chatKey,
	chats,
	contextPercent,
	draft,
	generalTelegram,
	type HarvestNote,
	type Item,
	liveTools,
	messages,
	modal,
	narrow,
	notes,
	openNote,
	partial,
	selectedBot,
	showList,
	tab,
} from "./state.ts";
import { setTheme, THEMES, theme, themeLabel } from "./theme.ts";

function tone(id: string): string {
	const sum = [...id].reduce((total, char) => total + char.charCodeAt(0), 0);
	return `g${(sum % 4) + 1}`;
}

function letter(name: string): string {
	return (name.trim()[0] ?? "?").toUpperCase();
}

export function App() {
	const listOpen = narrow.value && showList.value;
	const chatOpen = narrow.value && !showList.value;
	return (
		<div
			class={`app ${listOpen ? "list-open" : ""} ${chatOpen ? "chat-open" : ""}`}
		>
			<nav class="rail">
				<div class="bots">
					{bots.value.map((bot) => (
						<button
							type="button"
							key={bot.id}
							class={`av ${tone(bot.id)} ${bot.id === botId.value ? "sel" : ""}`}
							title={bot.name}
							onClick={() => void openBot(bot.id).catch(showError)}
						>
							{letter(bot.name)}
						</button>
					))}
					<button
						type="button"
						class="av add"
						title="New bot"
						onClick={() => (modal.value = "create")}
					>
						+
					</button>
				</div>
				<ProfileMenu />
			</nav>
			<Side />
			{tab.value === "knowledge" ? (
				<Knowledge />
			) : tab.value === "schedules" ? (
				<Schedules />
			) : (
				<Main />
			)}
			{modal.value ? <BotDialog /> : null}
		</div>
	);
}

function showError(error: Error) {
	banner.value = error.message;
}

function Side() {
	const bot = selectedBot();
	const count = chats.value.length;
	return (
		<aside class="side">
			<div class="bh">
				<div class="n">
					{bot?.name ?? "Bot"}{" "}
					{bot?.telegramConfigured ||
					(bot?.id === "default" && generalTelegram.value) ? (
						<span class="tg">TG</span>
					) : null}
				</div>
				<div class="m">
					{bot
						? `${bot.id} · ${bot.model}${bot.thinking ? ` · ${bot.thinking}` : ""}`
						: ""}
				</div>
			</div>
			<Tabs count={count} />
			{tab.value === "chats" ? (
				<ChatList />
			) : tab.value === "knowledge" ? (
				<KnowledgeList />
			) : tab.value === "schedules" ? (
				<ScheduleList />
			) : null}
		</aside>
	);
}

function ProfileMenu() {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const close = (event: PointerEvent) => {
			const node = root.current;
			if (node && event.target instanceof Node && node.contains(event.target))
				return;
			setOpen(false);
		};
		document.addEventListener("pointerdown", close);
		return () => document.removeEventListener("pointerdown", close);
	}, [open]);
	return (
		<div class="profile" ref={root}>
			<button
				type="button"
				class="av profile-btn"
				title="Profile"
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}
			>
				<UserIcon />
			</button>
			{open ? (
				<div class="pmenu">
					<div class="who">Profile</div>
					<div class="prow">
						<span>Theme</span>
						<div class="ticons">
							{THEMES.map((id) => (
								<button
									type="button"
									key={id}
									title={themeLabel(id)}
									aria-label={themeLabel(id)}
									class={theme.value === id ? "on" : ""}
									onClick={() => setTheme(id)}
								>
									{id === "light" ? (
										<SunIcon />
									) : id === "dark" ? (
										<MoonIcon />
									) : (
										<FlameIcon />
									)}
								</button>
							))}
						</div>
					</div>
				</div>
			) : null}
		</div>
	);
}

function UserIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			width="18"
			height="18"
			aria-hidden="true"
			fill="none"
			stroke="currentColor"
			stroke-width="1.8"
			stroke-linecap="round"
		>
			<circle cx="12" cy="8" r="3" />
			<path d="M5.5 19.5c1.4-3 3.4-4.5 6.5-4.5s5.1 1.5 6.5 4.5" />
		</svg>
	);
}

function SunIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			width="16"
			height="16"
			aria-hidden="true"
			fill="none"
			stroke="currentColor"
			stroke-width="1.8"
			stroke-linecap="round"
		>
			<circle cx="12" cy="12" r="3.2" />
			<path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M18 6l-1.4 1.4M7.4 16.6 6 18" />
		</svg>
	);
}

function MoonIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			width="16"
			height="16"
			aria-hidden="true"
			fill="none"
			stroke="currentColor"
			stroke-width="1.8"
			stroke-linecap="round"
			stroke-linejoin="round"
		>
			<path d="M20 14.5A8 8 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5z" />
		</svg>
	);
}

function FlameIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			width="16"
			height="16"
			aria-hidden="true"
			fill="none"
			stroke="currentColor"
			stroke-width="1.8"
			stroke-linecap="round"
			stroke-linejoin="round"
		>
			<path d="M12 3c.4 3-1.2 4.6-1.2 7.2A3.2 3.2 0 0 0 14 13c0-1.6.8-2.6 1.4-3.6C17.6 12 19 14 19 16.2A7 7 0 0 1 5 16c0-2.8 2.2-4.6 2.2-7.2C8.6 7.2 10 6 12 3z" />
		</svg>
	);
}

function Tabs({ count }: { count: number }) {
	const pick = (next: "chats" | "knowledge" | "schedules") => {
		tab.value = next;
		showList.value = true;
		if (next === "knowledge") ensureFiles();
		if (next === "schedules") ensureSchedules();
	};
	return (
		<div class="tabs">
			<button
				type="button"
				class={tab.value === "chats" ? "on" : ""}
				onClick={() => pick("chats")}
			>
				Chats {count}
			</button>
			<button
				type="button"
				class={tab.value === "knowledge" ? "on" : ""}
				onClick={() => pick("knowledge")}
			>
				Knowledge
			</button>
			<button
				type="button"
				class={tab.value === "schedules" ? "on" : ""}
				onClick={() => pick("schedules")}
			>
				Schedules
			</button>
			<button
				type="button"
				title="Settings"
				onClick={() => (modal.value = "edit")}
			>
				⚙
			</button>
		</div>
	);
}

function ChatList() {
	return (
		<div class="list">
			<button
				type="button"
				class="btn ghost"
				onClick={() => void createChat().catch(showError)}
			>
				New chat
			</button>
			{chats.value.map((chat) => (
				<button
					type="button"
					key={chat.key}
					class={`c ${chat.key === chatKey.value ? "sel" : ""}`}
					onClick={() => watchChat(chat.key)}
				>
					<div class="t">
						{rowTitle(chat)}
						<small>
							{chat.telegram ? (
								<span class="tg">TG</span>
							) : (
								<span class="web">WEB</span>
							)}
						</small>
					</div>
					<div class="key">{chat.key}</div>
					<div class="p">{rowPreview(chat)}</div>
				</button>
			))}
		</div>
	);
}

function rowTitle(chat: Chat): string {
	if (chat.title) return chat.title;
	if (chat.key === chatKey.value) {
		const first = messages.value.find((item) => item.type === "user");
		if (first && first.type === "user") return first.text.slice(0, 42);
	}
	return chat.telegram ? "Telegram" : "Web chat";
}

function rowPreview(chat: Chat): string {
	if (chat.key !== chatKey.value)
		return chat.telegram ? "Telegram chat" : "Web chat";
	const last = [...messages.value]
		.reverse()
		.find((item) => item.type !== "tool");
	return last && "text" in last ? last.text : "New chat";
}

function Main() {
	const key = chatKey.value;
	const bot = selectedBot();
	if (!key) {
		return (
			<main class="main">
				<div class="hd">
					<div class="t">No chat</div>
				</div>
				<div class="pg">
					<p class="mu">
						Start a new chat to talk to {bot?.name ?? "this bot"}.
					</p>
				</div>
			</main>
		);
	}
	const stored = chats.value.find((chat) => chat.key === key);
	const first = messages.value.find((item) => item.type === "user");
	const title =
		stored?.title ??
		(first && first.type === "user" ? first.text.slice(0, 64) : "New chat");
	const percent = contextPercent.value;
	return (
		<main class="main">
			<div class="hd">
				<button
					type="button"
					class="back"
					title="Chats"
					onClick={() => (showList.value = true)}
				>
					‹
				</button>
				<div
					class={`av ${tone(bot?.id ?? "default")}`}
					style="width:36px;height:36px;border-radius:10px"
				>
					{letter(bot?.name ?? "?")}
				</div>
				<div>
					<div class="t">{title}</div>
					<div class="key">
						{key}
						{bot ? ` · ${bot.model}` : ""}
					</div>
				</div>
				<div class="r">
					{percent === undefined ? null : (
						<span class="tag">ctx {percent}%</span>
					)}
					<button
						type="button"
						class="btn ghost"
						onClick={() => void send("/status").catch(showError)}
					>
						/status
					</button>
					<button
						type="button"
						class="btn ghost"
						onClick={() => void askRename().catch(showError)}
					>
						Rename
					</button>
					<button
						type="button"
						class="btn ghost"
						onClick={() => void deleteChat().catch(showError)}
					>
						Delete
					</button>
				</div>
			</div>
			{banner.value ? (
				<div class="errbox" style="margin:12px 20px 0">
					{banner.value}
				</div>
			) : null}
			<div class="msgs">
				<Timeline />
				{partial.value || liveTools.value.length > 0 ? (
					<div class="b">
						{liveTools.value.map((tool) => (
							<Chip
								key={`${tool.name}:${tool.status}`}
								name={tool.name}
								status={tool.status}
							/>
						))}
						<span
							dangerouslySetInnerHTML={{
								__html: renderMarkdown(partial.value),
							}}
						/>
						{busy.value ? <span class="caret" /> : null}
					</div>
				) : null}
			</div>
			<Composer />
		</main>
	);
}

function Timeline() {
	const placed = new Set<string>();
	const rows = [];
	for (const item of messages.value) {
		rows.push(<Bubble key={String(item.id)} item={item} />);
		if (typeof item.id !== "number") continue;
		for (const note of notes.value) {
			if (note.at !== item.id) continue;
			const id = `${note.at}:${note.when}`;
			if (placed.has(id)) continue;
			placed.add(id);
			rows.push(<Harvest key={id} note={note} />);
		}
	}
	for (const note of notes.value) {
		const id = `${note.at}:${note.when}`;
		if (placed.has(id)) continue;
		rows.push(<Harvest key={id} note={note} />);
	}
	return <>{rows}</>;
}

function Harvest({ note }: { note: HarvestNote }) {
	const id = note.at * 100000 + note.when;
	const open = openNote.value === note.when;
	const names = note.files.map((file) => file.path.split("/").pop()).join(", ");
	return (
		<div class="note">
			<button
				type="button"
				class="nh"
				onClick={() => (openNote.value = open ? null : note.when)}
			>
				<span class="pill">
					⋔ Knowledge updated{" "}
					<span class="mu2">
						· {names} · {new Date(note.when).toLocaleTimeString()}
					</span>{" "}
					{open ? "▾" : "▸"}
				</span>
			</button>
			{open ? (
				<div class="body">
					<div class="bh">
						<b>Harvest of this chat</b>
						<span class="mu">forked after idle</span>
						<span class="tag">not sent to the model</span>
					</div>
					{note.files.map((file) => (
						<div key={file.path} class="fl">
							<span class="ok">M</span>
							{file.path}
						</div>
					))}
					<div class="diff">
						{note.files.map((file) =>
							file.diff.split("\n").map((line, index) => (
								<div
									key={`${file.path}:${index}`}
									class={
										line.startsWith("+")
											? "a"
											: line.startsWith("-")
												? "r"
												: line.startsWith("@@")
													? "h"
													: ""
									}
								>
									{line}
								</div>
							)),
						)}
					</div>
					<div class="nf">
						<span class="mono">harvest note {id}</span>
					</div>
				</div>
			) : null}
		</div>
	);
}

async function askRename() {
	const title = window.prompt(
		"Chat title",
		chats.value.find((chat) => chat.key === chatKey.value)?.title ?? "",
	);
	if (!title?.trim()) return;
	await renameChat(title.trim());
}

function Bubble({ item }: { item: Item }) {
	if (item.type === "tool")
		return <Chip name={item.name} status={item.status} />;
	if (item.type === "user")
		return (
			<div
				class="b u"
				dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }}
			/>
		);
	return (
		<div
			class="b"
			dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }}
		/>
	);
}

function Chip({ name, status }: { name: string; status: string }) {
	const running = status === "running" || status === "pending";
	return (
		<span class={`chip ${running ? "run" : "w"}`}>
			{running ? <span class="spin" /> : "✓"} {name}
		</span>
	);
}

function Composer() {
	const submit = () => {
		const text = draft.value;
		if (!text.trim()) {
			if (busy.value) void send("/stop").catch(showError);
			return;
		}
		draft.value = "";
		void send(text).catch(showError);
	};
	return (
		<div class="comp">
			<div class="ib">
				<input
					class="i"
					placeholder={
						selectedBot() ? `Message ${selectedBot()?.name}…` : "Message…"
					}
					value={draft.value}
					onInput={(event) =>
						(draft.value = (event.currentTarget as HTMLInputElement).value)
					}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							submit();
						}
					}}
				/>
				{busy.value ? (
					<button
						type="button"
						class="btn stop"
						onClick={() => void send("/stop").catch(showError)}
					>
						■ Stop
					</button>
				) : (
					<button type="button" class="btn pri" onClick={submit}>
						Send
					</button>
				)}
			</div>
			<div class="hn">
				{["/new", "/stop", "/status", "/help"].map((command) => (
					<button
						type="button"
						key={command}
						class="hint"
						onClick={() => void send(command).catch(showError)}
					>
						<b>{command}</b>
					</button>
				))}
			</div>
		</div>
	);
}
