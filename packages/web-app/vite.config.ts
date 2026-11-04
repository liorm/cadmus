import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import istanbul from "vite-plugin-istanbul";

const coverage = process.env.CADMUS_COVERAGE === "1";

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), "VITE_");
	const allowedHosts = env.VITE_ALLOWED_HOSTS?.split(",")
		.map((host) => host.trim())
		.filter(Boolean);

	return {
		base: "/app/",
		plugins: [
			react(),
			tailwindcss(),
			...(coverage
				? [
						istanbul({
							cwd: path.resolve(__dirname),
							include: ["src/**"],
							exclude: ["**/*.test.ts", "tests/**", "node_modules/**"],
							extension: [".ts", ".tsx"],
							requireEnv: false,
							forceBuildInstrument: true,
							checkProd: false,
						}),
					]
				: []),
		],
		resolve: {
			alias: {
				"@": path.resolve(__dirname, "src"),
			},
		},
		build: {
			outDir: "dist",
			emptyOutDir: true,
			sourcemap: coverage,
		},
		server: {
			port: 5174,
			...(allowedHosts?.length ? { allowedHosts } : {}),
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
