import type { BotRecord } from "@cadmus/contract/types";
import { useNavigate } from "@tanstack/react-router";
import type { JSX, KeyboardEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCadmus } from "@/context/CadmusContext";
import { chatTitle } from "@/lib/format-time";

type PaletteRow = {
	id: string;
	label: string;
	hint?: string;
	run: () => void;
};

export function openCommandPalette(): void {
	window.dispatchEvent(new CustomEvent("cadmus:open-command-palette"));
}

export function CommandPaletteHost({
	onOpenChat,
}: {
	onOpenChat?: (chatKey: string) => void;
} = {}): JSX.Element {
	const navigate = useNavigate();
	const { bots, chats, chatStates } = useCadmus();
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [index, setIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);

	const show = useCallback(() => {
		setQuery("");
		setIndex(0);
		setOpen(true);
	}, []);

	useEffect(() => {
		function onOpen() {
			show();
		}
		function onKey(event: globalThis.KeyboardEvent) {
			if (event.repeat) return;
			if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
			if (event.key.toLowerCase() !== "k") return;
			event.preventDefault();
			setOpen((current) => {
				if (current) return false;
				setQuery("");
				setIndex(0);
				return true;
			});
		}
		window.addEventListener("cadmus:open-command-palette", onOpen);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("cadmus:open-command-palette", onOpen);
			window.removeEventListener("keydown", onKey);
		};
	}, [show]);

	useEffect(() => {
		if (!open) return;
		inputRef.current?.focus();
	}, [open]);

	const rows = useMemo(() => {
		const closeAnd = (run: () => void) => () => {
			setOpen(false);
			run();
		};
		const next: PaletteRow[] = [
			{
				id: "search",
				label: "Search",
				hint: "knowledge.search",
				run: closeAnd(() => {
					void navigate({ to: "/search" });
				}),
			},
			{
				id: "settings",
				label: "Settings",
				run: closeAnd(() => {
					void navigate({ to: "/settings" });
				}),
			},
			{
				id: "account",
				label: "Account",
				hint: "account.get",
				run: closeAnd(() => {
					void navigate({ to: "/settings/account" });
				}),
			},
			{
				id: "family",
				label: "Family",
				run: closeAnd(() => {
					void navigate({ to: "/settings/family" });
				}),
			},
			{
				id: "providers",
				label: "Providers",
				hint: "models",
				run: closeAnd(() => {
					void navigate({ to: "/settings/providers" });
				}),
			},
			{
				id: "tools-envs",
				label: "Tool environments",
				hint: "account.toolsEnvs",
				run: closeAnd(() => {
					void navigate({ to: "/settings/tools" });
				}),
			},
			{
				id: "all-schedules",
				label: "All schedules",
				run: closeAnd(() => {
					void navigate({ to: "/settings/schedules" });
				}),
			},
			{
				id: "archive",
				label: "Archive",
				run: closeAnd(() => {
					void navigate({ to: "/settings/archive" });
				}),
			},
			{
				id: "new-bot",
				label: "New bot",
				run: closeAnd(() => {
					void navigate({ to: "/bot/new" });
				}),
			},
			{
				id: "new-task",
				label: "New task",
				run: closeAnd(() => {
					void navigate({ to: "/new", search: {} });
				}),
			},
		];
		for (const bot of bots) {
			next.push(...botRows(bot, closeAnd, navigate));
		}
		for (const chat of chats) {
			if (chat.closed) continue;
			const key = chat.key;
			next.push({
				id: `chat:${key}`,
				label: chatTitle(chat, chatStates[key]?.lastUserText),
				hint: key,
				run: closeAnd(() => {
					if (onOpenChat) {
						onOpenChat(key);
						return;
					}
					const event = new CustomEvent("cadmus:open-chat", {
						cancelable: true,
						detail: { chatKey: key, botId: chat.botId },
					});
					window.dispatchEvent(event);
					if (event.defaultPrevented) return;
					void navigate({
						to: "/chat/$chatKey",
						params: { chatKey: key },
						search: { view: "chat" },
					});
				}),
			});
		}
		return next;
	}, [bots, chatStates, chats, navigate, onOpenChat]);

	const visible = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (!needle) return rows;
		return rows.filter((row) =>
			`${row.label} ${row.hint ?? ""}`.toLowerCase().includes(needle),
		);
	}, [query, rows]);
	const activeIndex =
		visible.length === 0 ? 0 : Math.min(index, visible.length - 1);

	useEffect(() => {
		if (visible.length === 0) return;
		rowRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
	}, [activeIndex, visible]);

	function onDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			setOpen(false);
			return;
		}
		if (event.key === "ArrowDown") {
			event.preventDefault();
			setIndex((current) => {
				const max = visible.length - 1;
				if (max < 0) return 0;
				return Math.min(Math.min(current, max) + 1, max);
			});
			return;
		}
		if (event.key === "ArrowUp") {
			event.preventDefault();
			setIndex((current) => {
				const max = visible.length - 1;
				if (max < 0) return 0;
				return Math.max(Math.min(current, max) - 1, 0);
			});
			return;
		}
		if (event.key === "Enter") {
			const row = visible[activeIndex];
			if (!row) return;
			event.preventDefault();
			row.run();
		}
	}

	if (!open) return <div hidden />;

	return (
		<div className="fixed inset-0 z-50 flex items-start justify-center bg-bg/70 p-4">
			<button
				type="button"
				aria-label="Close command palette"
				className="absolute inset-0"
				onClick={() => setOpen(false)}
			/>
			<div
				role="dialog"
				aria-label="Command palette"
				className="relative z-10 flex max-h-[70dvh] w-full max-w-lg flex-col overflow-hidden rounded-md border border-border bg-surface shadow-[var(--shadow)]"
				onKeyDown={onDialogKeyDown}
			>
				<input
					ref={inputRef}
					aria-label="Command filter"
					value={query}
					onChange={(event) => {
						setQuery(event.target.value);
						setIndex(0);
					}}
					className="border-b border-border bg-transparent px-3 py-2 text-[length:var(--fs-md)] outline-none"
				/>
				<div className="min-h-0 flex-1 overflow-y-auto">
					{visible.length === 0 ? (
						<p className="px-3 py-2 text-[length:var(--fs-sm)] text-text-muted">
							No matches.
						</p>
					) : (
						visible.map((row, rowIndex) => (
							<button
								key={row.id}
								ref={(node) => {
									rowRefs.current[rowIndex] = node;
								}}
								type="button"
								aria-current={rowIndex === activeIndex ? "true" : undefined}
								className={`flex min-h-tap w-full items-baseline gap-2 px-3 py-2 text-left ${rowIndex === activeIndex ? "bg-bg" : ""}`}
								onMouseEnter={() => setIndex(rowIndex)}
								onClick={() => row.run()}
							>
								<span className="min-w-0 flex-1 truncate">{row.label}</span>
								{row.hint ? (
									<span className="truncate text-[length:var(--fs-xs)] text-text-muted">
										{row.hint}
									</span>
								) : null}
							</button>
						))
					)}
				</div>
			</div>
		</div>
	);
}

function botRows(
	bot: BotRecord,
	closeAnd: (run: () => void) => () => void,
	navigate: ReturnType<typeof useNavigate>,
): PaletteRow[] {
	const pages: Array<{
		id: string;
		label: string;
		run: () => void;
	}> = [
		{
			id: "schedules",
			label: "Profile schedules",
			run: () => {
				void navigate({
					to: "/bot/$botId/$tab",
					params: { botId: bot.id, tab: "schedules" },
				});
			},
		},
		{
			id: "memory",
			label: "Memory",
			run: () => {
				void navigate({
					to: "/bot/$botId/$tab",
					params: { botId: bot.id, tab: "memory" },
				});
			},
		},
		{
			id: "knowledge",
			label: "Knowledge",
			run: () => {
				void navigate({
					to: "/bot/$botId/$tab",
					params: { botId: bot.id, tab: "knowledge" },
				});
			},
		},
		{
			id: "soul",
			label: "Soul",
			run: () => {
				void navigate({
					to: "/bot/$botId/$tab",
					params: { botId: bot.id, tab: "soul" },
				});
			},
		},
		{
			id: "config",
			label: "Config",
			run: () => {
				void navigate({
					to: "/bot/$botId/$tab",
					params: { botId: bot.id, tab: "config" },
				});
			},
		},
		{
			id: "tools",
			label: "Tools",
			run: () => {
				void navigate({ to: "/bot/$botId/tools", params: { botId: bot.id } });
			},
		},
		{
			id: "harvest",
			label: "Harvest",
			run: () => {
				void navigate({
					to: "/bot/$botId/harvest",
					params: { botId: bot.id },
				});
			},
		},
	];
	return pages.map((page) => ({
		id: `${bot.id}:${page.id}`,
		label: `${bot.name} · ${page.label}`,
		hint: bot.id,
		run: closeAnd(page.run),
	}));
}
