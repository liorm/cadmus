import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { BottomSheet } from "@/components/BottomSheet";
import { Composer } from "@/components/Composer";
import { ListRow } from "@/components/ListRow";
import { LiveCard } from "@/components/LiveCard";
import { StatusShape } from "@/components/StatusShape";
import { UnreadDot } from "@/components/UnreadDot";
import { Button } from "@/components/ui/button";
import { useCadmus } from "@/context/CadmusContext";

export function HomePage() {
	const { bots, chats, client, refreshDirectory } = useCadmus();
	const [sheetOpen, setSheetOpen] = useState(false);
	const [lastSent, setLastSent] = useState("");
	return (
		<AppShell
			title="Cadmus"
			showBack={false}
			actions={
				<>
					<Link
						to="/search"
						aria-label="Search"
						className="inline-flex min-h-tap min-w-tap items-center justify-center"
					>
						⌕
					</Link>
					<Link
						to="/settings"
						aria-label="Settings"
						className="inline-flex min-h-tap min-w-tap items-center justify-center"
					>
						⚙
					</Link>
				</>
			}
		>
			<div className="flex flex-1 flex-col">
				<nav aria-label="Bots" className="flex flex-col">
					{bots.map((bot) => (
						<ListRow
							key={bot.id}
							onClick={() => undefined}
							trailing={
								<>
									<StatusShape status="none" />
									<UnreadDot />
								</>
							}
						>
							{bot.name}
						</ListRow>
					))}
				</nav>
				<nav aria-label="Chats" className="flex flex-col">
					{chats.map((chat) => (
						<ListRow key={chat.key} onClick={() => undefined}>
							{chat.title?.trim() || chat.key}
						</ListRow>
					))}
				</nav>
				<div className="p-4">
					<BottomSheet
						open={sheetOpen}
						onOpenChange={setSheetOpen}
						title="Group menu"
						trigger={<Button>Open menu</Button>}
					>
						<Button variant="ghost" className="w-full justify-start">
							Profile
						</Button>
					</BottomSheet>
				</div>
				<div className="px-4">
					<LiveCard title="Live">Waiting for a turn.</LiveCard>
				</div>
				{lastSent ? (
					<p className="px-4 pt-3 text-[length:var(--fs-sm)] text-text-muted">
						Last sent: {lastSent}
					</p>
				) : null}
				<div className="mt-auto">
					<Composer
						steerEnabled
						onSend={(text) => {
							setLastSent(text);
							const bot = bots[0];
							if (!bot) return;
							void client
								.callRpc("chat.create", { botId: bot.id, title: text })
								.then(() => refreshDirectory());
						}}
					/>
				</div>
			</div>
		</AppShell>
	);
}
