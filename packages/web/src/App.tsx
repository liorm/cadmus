import { BotDirectory } from "./components/BotDirectory.js";
import { ChatWorkspace } from "./components/ChatWorkspace.js";
import { FileInspector } from "./components/FileInspector.js";
import { HarvestInspector } from "./components/HarvestInspector.js";
import { SchedulesPanel } from "./components/SchedulesPanel.js";
import { TopBar } from "./components/TopBar.js";
import {
	CadmusProvider,
	type CadmusProviderProps,
	useCadmus,
} from "./context/CadmusContext.js";

function AppShell() {
	const { connectionStatus, authConfig, bots, activeTab } = useCadmus();

	return (
		<div className="app-container">
			{/* Top Bar with Brand, Identity, Family Selector, Nav Tabs, and Settings */}
			<TopBar />

			{/* Main Content Workspace */}
			<main className="main-content">
				{activeTab === "chat" && <ChatWorkspace />}

				{activeTab === "bots" && (
					<div className="bots-view-container">
						<BotDirectory />
						<FileInspector />
					</div>
				)}

				{activeTab === "schedules" && (
					<div className="schedules-view-container">
						<SchedulesPanel />
						<HarvestInspector />
					</div>
				)}
			</main>

			{/* Status Bar */}
			<footer className="bottom-status-bar">
				<div className="status-left">
					<span className="status-item">
						<span>Account:</span>
						<strong style={{ color: "var(--text-secondary)" }}>
							{authConfig.accountId}
						</strong>
					</span>
					<span className="status-item">
						<span>Family:</span>
						<strong style={{ color: "var(--text-secondary)" }}>
							{authConfig.familyId}
						</strong>
					</span>
					<span className="status-item">
						<span>User:</span>
						<strong style={{ color: "var(--text-secondary)" }}>
							{authConfig.userId}
						</strong>
					</span>
				</div>
				<div className="status-right">
					<span className="status-item">
						<span>Bots:</span>
						<strong>{bots.length}</strong>
					</span>
					<span className="status-item">
						<span>RPC:</span>
						<strong style={{ color: "var(--accent-emerald)" }}>HTTP</strong>
					</span>
					<span className="status-item">
						<span>Events:</span>
						<strong
							style={{
								color:
									connectionStatus === "connected"
										? "var(--accent-emerald)"
										: "var(--accent-rose)",
							}}
						>
							WS
						</strong>
					</span>
				</div>
			</footer>
		</div>
	);
}

export type AppProps = Omit<CadmusProviderProps, "children">;

export function App(props?: AppProps) {
	return (
		<CadmusProvider {...props}>
			<AppShell />
		</CadmusProvider>
	);
}
