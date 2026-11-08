import type { BotRecord } from "@cadmus/contract/types";
import { Link } from "@tanstack/react-router";
import { type JSX, useEffect, useState } from "react";
import { Composer } from "@/components/Composer";
import { useCadmus } from "@/context/CadmusContext";
import { ChatSession } from "@/routes/chat";

const STARTERS = [
	"What can you help with?",
	"Summarize your memory",
	"What is on your schedule?",
] as const;

function firstPersonaParagraph(raw: string): string | null {
	const blocks = raw.replace(/```[\s\S]*?```/g, "\n\n").split(/\n{2,}/);
	for (const block of blocks) {
		const lines = block
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith("#"));
		const text = lines.join(" ").replace(/\s+/g, " ").trim();
		if (!text) continue;
		if (text.length <= 400) return text;
		return `${text.slice(0, 400).trimEnd()}…`;
	}
	return null;
}

export function DesktopChatConsole({
	chatKey,
	botId,
	onChatCreated,
	onArchived,
}: {
	chatKey: string | null;
	botId: string;
	onChatCreated: (chatKey: string) => void;
	onArchived?: () => void;
}): JSX.Element {
	const {
		bots,
		client,
		noteUserText,
		queueTurn,
		refreshDirectory,
		setLastBotId,
	} = useCadmus();
	const [viewFor, setViewFor] = useState<{
		key: string | null;
		view: "chat" | "raw";
	}>({ key: chatKey, view: "chat" });
	const view = viewFor.key === chatKey ? viewFor.view : "chat";
	const [persona, setPersona] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const bot = bots.find((entry) => entry.id === botId);

	useEffect(() => {
		let cancelled = false;
		setPersona(null);
		if (chatKey || !botId) return;
		void client
			.callRpc("file.read", { botId, path: "SOUL.md" })
			.then((res) => {
				if (cancelled || !res.ok || !res.result || !("text" in res.result)) {
					return;
				}
				const next = firstPersonaParagraph(
					res.result.text || res.result.content || "",
				);
				if (next) setPersona(next);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [botId, chatKey, client]);

	async function beginChat(text: string, steer: boolean) {
		const trimmed = text.trim();
		if (!botId || !trimmed || pending) return;
		setPending(true);
		try {
			setLastBotId(botId);
			const created = await client.callRpc("chat.create", {
				botId,
				kind: "direct",
			});
			if (!created.ok || !created.result?.chat) return;
			const createdKey = created.result.chat.key;
			noteUserText(createdKey, trimmed);
			queueTurn({
				chatKey: createdKey,
				text: trimmed,
				clientMsgId: crypto.randomUUID(),
				whenBusy: steer ? "steer" : "queue",
			});
			onChatCreated(createdKey);
			await refreshDirectory();
		} catch {
			return;
		} finally {
			setPending(false);
		}
	}

	if (chatKey) {
		return (
			<ChatSession
				chatKey={chatKey}
				view={view}
				embedded
				onArchived={onArchived}
				onViewChange={(next) => {
					setViewFor({ key: chatKey, view: next });
				}}
			/>
		);
	}

	if (!botId) {
		return (
			<section
				aria-label="Chat console"
				className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 text-center"
			>
				<p>Create a bot to start</p>
				<Link to="/bot/new" className="text-accent">
					New bot
				</Link>
			</section>
		);
	}

	return (
		<section aria-label="Chat console" className="flex h-full min-h-0 flex-col">
			<div className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
				{bot ? <BotIntro bot={bot} persona={persona} /> : null}
				<div className="mt-4 flex flex-col items-start gap-2">
					{STARTERS.map((prompt) => (
						<button
							key={prompt}
							type="button"
							disabled={pending}
							onClick={() => {
								void beginChat(prompt, false);
							}}
							className="rounded-full border border-border px-3 py-2 text-left text-[length:var(--fs-sm)] disabled:opacity-50"
						>
							{prompt}
						</button>
					))}
				</div>
			</div>
			<Composer
				disabled={pending}
				steerEnabled
				onSend={(text, steer) => {
					void beginChat(text, steer);
				}}
			/>
		</section>
	);
}

function BotIntro({
	bot,
	persona,
}: {
	bot: BotRecord;
	persona: string | null;
}) {
	return (
		<div className="flex flex-col gap-2">
			<h2 className="text-[length:var(--fs-lg)] font-semibold">{bot.name}</h2>
			<p className="text-[length:var(--fs-sm)] text-text-muted">{bot.model}</p>
			<p className="text-[length:var(--fs-sm)] text-text-muted">
				{bot.timezone}
			</p>
			{bot.tools ? (
				<ul className="flex flex-wrap gap-2">
					{bot.tools.map((tool) => (
						<li
							key={tool}
							className="rounded-full border border-border px-2 py-0.5 text-[length:var(--fs-xs)] text-text-muted"
						>
							{tool}
						</li>
					))}
				</ul>
			) : (
				<p className="text-[length:var(--fs-sm)] text-text-muted">
					Default tools
				</p>
			)}
			{persona ? (
				<p className="max-w-prose text-[length:var(--fs-sm)] text-text">
					{persona}
				</p>
			) : null}
		</div>
	);
}
