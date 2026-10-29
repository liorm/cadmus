import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), "VITE_");
	const allowedHosts = env.VITE_ALLOWED_HOSTS?.split(",")
		.map((host) => host.trim())
		.filter(Boolean);

	return {
		plugins: [react()],
		build: {
			outDir: "dist",
			emptyOutDir: true,
		},
		server: {
			port: 5173,
			...(allowedHosts?.length ? { allowedHosts } : {}),
			// Same paths as wrangler.jsonc assets.run_worker_first, including the
			// /api/* and /tools-env/* globs. A `^` key is a regex. WebSocket
			// upgrades (chat /ws and daemon /tools-env/ws) need ws: true.
			proxy: {
				"^/(health|protocol/schema|ws|events|rpc|api(?:/.*)?|tools-env(?:/.*)?)":
					{
						target: "http://localhost:8787",
						ws: true,
					},
			},
		},
	};
});
