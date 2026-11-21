import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { SessionBoot } from "@/context/SessionContext";
import { applyStoredTheme } from "@/theme/theme";
import "@/styles/app.css";

applyStoredTheme();

const LazyAppRoot = lazy(() => import("@/AppRoot"));

const rootElement = document.getElementById("root");
if (rootElement) {
	ReactDOM.createRoot(rootElement).render(
		<React.StrictMode>
			<SessionBoot>
				{() => (
					<Suspense fallback={null}>
						<LazyAppRoot />
					</Suspense>
				)}
			</SessionBoot>
		</React.StrictMode>,
	);
}
