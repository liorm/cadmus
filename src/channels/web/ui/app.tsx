import { renderMarkdown } from "./markdown.ts";
import { createChat, openBot, send, watchChat } from "./client.ts";
import { banner, botId, bots, busy, chatKey, chats, draft, liveTools, messages, modal, partial, selectedBot, tab, type Chat, type Item } from "./state.ts";
import { NewBot } from "./new-bot.tsx";

function tone(id: string): string {
	const sum = [...id].reduce((total, char) => total + char.charCodeAt(0), 0);
	return `g${(sum % 4) + 1}`;
}

function letter(name: string): string {
	return (name.trim()[0] ?? "?").toUpperCase();
}

export function App() {
	return (
		<div class="app">
			<nav class="rail">
				{bots.value.map((bot) => (
					<button key={bot.id} class={`av ${tone(bot.id)} ${bot.id === botId.value ? "sel" : ""}`} title={bot.name} onClick={() => void openBot(bot.id).catch(showError)}>
						{letter(bot.name)}
					</button>
				))}
				<button class="av add" title="New bot" onClick={() => (modal.value = true)}>+</button>
			</nav>
			<Side />
			<Main />
			{modal.value ? <NewBot /> : null}
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
					{bot?.name ?? "Bot"} {bot?.id === "default" ? <span class="tg">TG</span> : null}
				</div>
				<div class="m">
					{bot ? `${bot.id} · ${bot.model}${bot.thinking ? ` · ${bot.thinking}` : ""}` : ""}
				</div>
			</div>
			<div class="tabs">
				<span class={tab.value === "chats" ? "on" : ""} onClick={() => (tab.value = "chats")}>Chats {count}</span>
				<span class={tab.value === "knowledge" ? "on" : ""} onClick={() => (tab.value = "knowledge")}>Knowledge</span>
				<span class={tab.value === "schedules" ? "on" : ""} onClick={() => (tab.value = "schedules")}>Schedules</span>
			</div>
			{tab.value === "chats" ? <ChatList /> : <div class="pg"><p class="mu">Nothing here yet.</p></div>}
		</aside>
	);
}

function ChatList() {
	return (
		<div class="list">
			<button class="btn ghost" onClick={() => void createChat().catch(showError)}>New chat</button>
			{chats.value.map((chat) => (
				<button key={chat.key} class={`c ${chat.key === chatKey.value ? "sel" : ""}`} onClick={() => watchChat(chat.key)}>
					<div class="t">
						{rowTitle(chat)}
						<small>{chat.telegram ? <span class="tg">TG</span> : <span class="web">WEB</span>}</small>
					</div>
					<div class="key">{chat.key}</div>
					<div class="p">{rowPreview(chat)}</div>
				</button>
			))}
		</div>
	);
}

function rowTitle(chat: Chat): string {
	if (chat.key === chatKey.value) {
		const first = messages.value.find((item) => item.type === "user");
		if (first && first.type === "user") return first.text.slice(0, 42);
	}
	return chat.telegram ? "Telegram" : "Web chat";
}

function rowPreview(chat: Chat): string {
	if (chat.key !== chatKey.value) return chat.telegram ? "Telegram chat" : "Web chat";
	const last = [...messages.value].reverse().find((item) => item.type !== "tool");
	return last && "text" in last ? last.text : "New chat";
}

function Main() {
	const key = chatKey.value;
	const bot = selectedBot();
	if (tab.value !== "chats") {
		return (
			<main class="main">
				<div class="hd"><div class="t">{tab.value === "knowledge" ? "Knowledge" : "Schedules"}</div></div>
				<div class="pg"><p class="mu">Nothing here yet.</p></div>
			</main>
		);
	}
	if (!key) {
		return (
			<main class="main">
				<div class="hd"><div class="t">No chat</div></div>
				<div class="pg"><p class="mu">Start a new chat to talk to {bot?.name ?? "this bot"}.</p></div>
			</main>
		);
	}
	const first = messages.value.find((item) => item.type === "user");
	const title = first && first.type === "user" ? first.text.slice(0, 64) : "New chat";
	return (
		<main class="main">
			<div class="hd">
				<div class={`av ${tone(bot?.id ?? "default")}`} style="width:36px;height:36px;border-radius:10px">{letter(bot?.name ?? "?")}</div>
				<div>
					<div class="t">{title}</div>
					<div class="key">{key}{bot ? ` · ${bot.model}` : ""}</div>
				</div>
			</div>
			{banner.value ? <div class="errbox" style="margin:12px 20px 0">{banner.value}</div> : null}
			<div class="msgs">
				{messages.value.map((item) => <Bubble key={item.id} item={item} />)}
				{partial.value || liveTools.value.length > 0 ? (
					<div class="b">
						{liveTools.value.map((tool) => <Chip key={`${tool.name}:${tool.status}`} name={tool.name} status={tool.status} />)}
						<span dangerouslySetInnerHTML={{ __html: renderMarkdown(partial.value) }} />
						{busy.value ? <span class="caret" /> : null}
					</div>
				) : null}
			</div>
			<Composer />
		</main>
	);
}

function Bubble({ item }: { item: Item }) {
	if (item.type === "tool") return <Chip name={item.name} status={item.status} />;
	if (item.type === "user") return <div class="b u" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }} />;
	return <div class="b" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }} />;
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
					placeholder={selectedBot() ? `Message ${selectedBot()?.name}…` : "Message…"}
					value={draft.value}
					onInput={(event) => (draft.value = (event.currentTarget as HTMLInputElement).value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							submit();
						}
					}}
				/>
				{busy.value ? (
					<button class="btn stop" onClick={() => void send("/stop").catch(showError)}>■ Stop</button>
				) : (
					<button class="btn pri" onClick={submit}>Send</button>
				)}
			</div>
			<div class="hn">
				{["/new", "/stop", "/status", "/help"].map((command) => (
					<button key={command} class="hint" onClick={() => void send(command).catch(showError)}><b>{command}</b></button>
				))}
			</div>
		</div>
	);
}

