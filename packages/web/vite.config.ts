import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react()],
	build: {
		outDir: "dist",
		emptyOutDir: true,
	},
	server: {
		port: 5173,
		proxy: {
			"/api": "http://localhost:8787",
			"/rpc": "http://localhost:8787",
			"/events": "http://localhost:8787",
			"/health": "http://localhost:8787",
			"/protocol/schema": "http://localhost:8787",
			"/ws": {
				target: "ws://localhost:8787",
				ws: true,
			},
		},
	},
});
