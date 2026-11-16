import { Link } from "@tanstack/react-router";
import {
	type JSX,
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useRef,
	useState,
} from "react";
import { AdminModeBanner } from "@/components/AdminModeBanner";
import { ReconnectBar } from "@/components/ReconnectBar";
import { useCadmus } from "@/context/CadmusContext";
import { needsYou } from "@/lib/needs-you";
import { cn } from "@/lib/utils";
import { openCommandPalette } from "./CommandPalette";
import {
	clampPaneWidth,
	MAX_PANE_WIDTH,
	MIN_PANE_WIDTH,
	type PaneSizes,
	readPaneSizes,
	resetPaneSizes,
	writePaneSizes,
} from "./pane-sizes";

type PaneKey = keyof PaneSizes;

function isTypingTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	const tag = target.tagName;
	return tag === "INPUT" || tag === "TEXTAREA";
}

export function CockpitFrame({
	fleet,
	stage,
	telemetry,
	bots,
	onSelectBot,
}: {
	fleet: ReactNode;
	stage: ReactNode;
	telemetry: ReactNode;
	bots: { id: string; name: string }[];
	onSelectBot: (botId: string) => void;
}): JSX.Element {
	const {
		familyId,
		bots: directoryBots,
		chats,
		chatStates,
		lastSeen,
		refreshDirectory,
	} = useCadmus();
	const [sizes, setSizes] = useState(readPaneSizes);
	const sizesRef = useRef(sizes);
	const dragRef = useRef<{
		pane: PaneKey;
		startX: number;
		startWidth: number;
	} | null>(null);

	const running = Object.values(chatStates).filter(
		(state) => state.busy,
	).length;
	const needs = needsYou(chats, chatStates, lastSeen).length;

	function setPaneWidth(pane: PaneKey, width: number, persist: boolean) {
		const next = {
			...sizesRef.current,
			[pane]: clampPaneWidth(width),
		};
		sizesRef.current = next;
		setSizes(next);
		if (persist) writePaneSizes(next);
	}

	useEffect(() => {
		function onKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") return;
			if (isTypingTarget(event.target)) return;
			const command = event.metaKey || event.ctrlKey;
			if (!command || event.altKey || event.shiftKey) return;
			if (event.metaKey && event.ctrlKey) return;
			if (!/^[1-9]$/.test(event.key)) return;
			const bot = bots[Number(event.key) - 1];
			if (!bot) return;
			event.preventDefault();
			onSelectBot(bot.id);
		}
		// Attach to `document` rather than `window` so Obscura never drops the
		// shortcut listener across SPA navigations.
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [bots, onSelectBot]);

	function onPointerDown(
		pane: PaneKey,
		event: ReactPointerEvent<HTMLDivElement>,
	) {
		if (event.button !== 0) return;
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		dragRef.current = {
			pane,
			startX: event.clientX,
			startWidth: sizesRef.current[pane],
		};
	}

	function onPointerMove(event: ReactPointerEvent<HTMLElement>) {
		const drag = dragRef.current;
		if (!drag) return;
		const delta = event.clientX - drag.startX;
		const width =
			drag.pane === "fleet" ? drag.startWidth + delta : drag.startWidth - delta;
		setPaneWidth(drag.pane, width, false);
	}

	function onPointerUp() {
		if (!dragRef.current) return;
		dragRef.current = null;
		writePaneSizes(sizesRef.current);
	}

	function onSeparatorKeyDown(
		pane: PaneKey,
		event: ReactKeyboardEvent<HTMLElement>,
	) {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		event.preventDefault();
		const towardEnd = event.key === "ArrowRight" ? 16 : -16;
		const delta = pane === "fleet" ? towardEnd : -towardEnd;
		setPaneWidth(pane, sizesRef.current[pane] + delta, true);
	}

	function onSeparatorDoubleClick(pane: PaneKey) {
		setPaneWidth(pane, resetPaneSizes()[pane], true);
	}

	return (
		<div className="flex h-[100dvh] w-full flex-col overflow-hidden bg-bg font-sans text-text">
			{/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: the cockpit header is named for assistive tech */}
			<header
				aria-label="Cadmus Cockpit"
				className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-surface px-3"
			>
				<span aria-hidden="true" className="flex shrink-0 items-center gap-1">
					<span className="size-2.5 rounded-full bg-[#ff5f57]" />
					<span className="size-2.5 rounded-full bg-[#febc2e]" />
					<span className="size-2.5 rounded-full bg-[#28c840]" />
				</span>
				<span className="shrink-0 text-[length:var(--fs-sm)] font-medium">
					Cadmus Cockpit
				</span>
				<Link
					to="/settings/family"
					className="max-w-48 truncate rounded-full border border-border bg-bg px-2 py-0.5 text-[length:var(--fs-xs)] text-accent"
					title={familyId}
				>
					{familyId}
				</Link>
				<div className="ml-auto flex min-w-0 items-center gap-3 text-[length:var(--fs-xs)] text-text-muted">
					<span className="inline-flex items-center gap-1.5">
						<span
							aria-hidden="true"
							className="size-2 shrink-0 rounded-full bg-status-done"
						/>
						{directoryBots.length} Bots Online
					</span>
					<span className="inline-flex items-center gap-1.5">
						<span
							aria-hidden="true"
							className="size-2 shrink-0 rounded-full bg-status-running"
						/>
						{running} Running
					</span>
					<span className="inline-flex items-center gap-1.5">
						<span
							aria-hidden="true"
							className="size-2 shrink-0 rounded-full bg-status-needs-you"
						/>
						{needs} Needs Attention
					</span>
				</div>
				<button
					type="button"
					aria-label="Search"
					className="inline-flex h-8 shrink-0 items-center rounded-md border border-border px-2 text-[length:var(--fs-xs)] text-text-muted"
					onClick={() => {
						openCommandPalette();
					}}
				>
					⌘K
				</button>
				<button
					type="button"
					aria-label="Refresh fleet"
					className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-text-muted"
					onClick={() => {
						void refreshDirectory();
					}}
				>
					↻
				</button>
				<Link
					to="/settings"
					aria-label="Settings"
					className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-text-muted"
				>
					⚙
				</Link>
			</header>
			<ReconnectBar />
			<AdminModeBanner />
			<div className="flex min-h-0 flex-1">
				<div
					className="min-h-0 shrink-0 overflow-hidden"
					style={{ width: sizes.fleet }}
				>
					{fleet}
				</div>
				{/* biome-ignore lint/a11y/useSemanticElements: vertical pane splitter, not a thematic break */}
				<div
					role="separator"
					aria-orientation="vertical"
					aria-label="Resize fleet"
					aria-valuemin={MIN_PANE_WIDTH}
					aria-valuemax={MAX_PANE_WIDTH}
					aria-valuenow={sizes.fleet}
					tabIndex={0}
					className={cn(
						"w-1.5 shrink-0 cursor-col-resize bg-border outline-none hover:bg-accent focus-visible:bg-accent",
					)}
					onPointerDown={(event) => {
						onPointerDown("fleet", event);
					}}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerUp}
					onPointerCancel={onPointerUp}
					onKeyDown={(event) => {
						onSeparatorKeyDown("fleet", event);
					}}
					onDoubleClick={() => {
						onSeparatorDoubleClick("fleet");
					}}
				/>
				<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
					{stage}
				</div>
				{/* biome-ignore lint/a11y/useSemanticElements: vertical pane splitter, not a thematic break */}
				<div
					role="separator"
					aria-orientation="vertical"
					aria-label="Resize telemetry"
					aria-valuemin={MIN_PANE_WIDTH}
					aria-valuemax={MAX_PANE_WIDTH}
					aria-valuenow={sizes.telemetry}
					tabIndex={0}
					className={cn(
						"w-1.5 shrink-0 cursor-col-resize bg-border outline-none hover:bg-accent focus-visible:bg-accent",
					)}
					onPointerDown={(event) => {
						onPointerDown("telemetry", event);
					}}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerUp}
					onPointerCancel={onPointerUp}
					onKeyDown={(event) => {
						onSeparatorKeyDown("telemetry", event);
					}}
					onDoubleClick={() => {
						onSeparatorDoubleClick("telemetry");
					}}
				/>
				<div
					className="min-h-0 shrink-0 overflow-hidden"
					style={{ width: sizes.telemetry }}
				>
					{telemetry}
				</div>
			</div>
		</div>
	);
}
