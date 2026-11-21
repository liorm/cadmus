import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), "VITE_");
	const allowedHosts = env.VITE_ALLOWED_HOSTS?.split(",")
		.map((host) => host.trim())
		.filter(Boolean);

	return {
		base: "/login/",
		plugins: [react(), tailwindcss()],
		resolve: {
			alias: {
				"@": path.resolve(__dirname, "src"),
			},
		},
		build: {
			outDir: "dist",
			emptyOutDir: true,
		},
		server: {
			port: 5175,
			...(allowedHosts?.length ? { allowedHosts } : {}),
			proxy: {
				"^/(health|protocol/schema|ws|events|rpc|api(?:/.*)?|tools-env(?:/.*)?)":
					{
						target: "http://localhost:8787",
						ws: true,
					},
				"^/app(?:/.*)?$": {
					target: "http://localhost:5174",
				},
			},
		},
	};
});
