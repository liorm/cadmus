/**
 * `bun run check:all`.
 *
 * Static stages share a pool of two processes (a 2-vCPU runner). E2E runs
 * after them so typecheck and the web build do not starve workerd timers.
 * `bun run test` then uses two Vitest workers (two miniflares). Keeping e2e
 * in its own stage leaves those CPUs to workerd. This stage runs the bun
 * conformance tests only. `bun run test:conformance` still runs both, on its own.
 *
 * `--group static` or `--group e2e` selects one half. The default runs both.
 * A static failure skips e2e, matching the old `&&` chain.
 */
import { spawn } from "node:child_process";
import {
	armChildSignals,
	disarmChildSignals,
	reportChildClose,
	trackChild,
} from "./child-close.ts";

type Group = "static" | "e2e";

type Stage = {
	name: string;
	cmd: string[];
	group: Group;
	weight: number;
};

const stages: Stage[] = [
	{
		name: "boundaries",
		cmd: ["bun", "run", "boundaries"],
		group: "static",
		weight: 5,
	},
	{
		name: "contract:check",
		cmd: ["bun", "run", "contract:check"],
		group: "static",
		weight: 15,
	},
	{
		name: "test:unit",
		cmd: ["bun", "run", "test:unit"],
		group: "static",
		weight: 10,
	},
	{
		name: "web:test",
		cmd: ["bun", "run", "web:test"],
		group: "static",
		weight: 8,
	},
	{
		name: "web:build",
		cmd: ["bun", "run", "web:build"],
		group: "static",
		weight: 40,
	},
	{
		name: "format:check",
		cmd: ["bun", "run", "format:check"],
		group: "static",
		weight: 12,
	},
	{
		name: "biome check",
		cmd: ["bun", "run", "lint"],
		group: "static",
		weight: 25,
	},
	{
		name: "typecheck",
		cmd: ["bun", "run", "typecheck"],
		group: "static",
		weight: 100,
	},
	{
		name: "test:daemon",
		cmd: ["bun", "run", "test:daemon"],
		group: "static",
		weight: 8,
	},
	{
		name: "test:conformance",
		cmd: ["bun", "test", "tests/conformance"],
		group: "static",
		weight: 30,
	},
	{ name: "test", cmd: ["bun", "run", "test"], group: "e2e", weight: 100 },
];

const staticConcurrency = 2;

type Result = {
	name: string;
	code: number;
	seconds: number;
	output: string;
	skipped: boolean;
};

function parseGroup(): "all" | Group {
	const args = process.argv.slice(2);
	if (args.length === 0) return "all";
	if (args.length === 2 && args[0] === "--group") {
		const value = args[1];
		if (value === "all" || value === "static" || value === "e2e") return value;
	}
	process.stderr.write(
		"usage: bun scripts/check-all.ts [--group all|static|e2e]\n",
	);
	process.exit(2);
}

function run(stage: Stage): Promise<Result> {
	const started = performance.now();
	return new Promise((resolve) => {
		const child = spawn(stage.cmd[0] ?? "bun", stage.cmd.slice(1), {
			stdio: ["ignore", "pipe", "pipe"],
		});
		trackChild(child);
		const chunks: Buffer[] = [];
		child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
		const finish = (code: number, output: string): void => {
			resolve({
				name: stage.name,
				code,
				seconds: (performance.now() - started) / 1000,
				output,
				skipped: false,
			});
		};
		child.on("error", (error) =>
			finish(1, `${String(error)}\n${Buffer.concat(chunks).toString("utf8")}`),
		);
		child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
			const closed = reportChildClose(
				Buffer.concat(chunks).toString("utf8"),
				code,
				signal,
			);
			finish(closed.code, closed.output);
		});
	});
}

function printResult(result: Result): void {
	const status = result.skipped ? "skip" : result.code === 0 ? "ok" : "FAIL";
	process.stdout.write(
		`\n──── ${result.name} (${status}, ${result.seconds.toFixed(2)}s) ────\n`,
	);
	const text = result.output.trimEnd();
	if (text.length > 0) {
		for (const line of text.split("\n")) {
			process.stdout.write(`[${result.name}] ${line}\n`);
		}
	}
}

async function runPool(list: Stage[], concurrency: number): Promise<Result[]> {
	const queue = [...list].sort((a, b) => b.weight - a.weight);
	const results: Result[] = [];
	let cursor = 0;
	async function worker(): Promise<void> {
		while (cursor < queue.length) {
			const stage = queue[cursor];
			cursor += 1;
			if (!stage) return;
			const result = await run(stage);
			results.push(result);
			printResult(result);
		}
	}
	const workers = Math.min(concurrency, queue.length);
	await Promise.all(Array.from({ length: workers }, () => worker()));
	return results;
}

function printSummary(results: Result[]): void {
	process.stdout.write("\ncheck:all\n");
	process.stdout.write("stage                status   seconds\n");
	for (const stage of stages) {
		const result = results.find((item) => item.name === stage.name);
		if (!result) continue;
		const status = result.skipped ? "skip" : result.code === 0 ? "ok" : "FAIL";
		process.stdout.write(
			`${result.name.padEnd(20)} ${status.padEnd(8)} ${result.seconds.toFixed(2)}\n`,
		);
	}
	const total = results.reduce((sum, result) => sum + result.seconds, 0);
	process.stdout.write(
		`${"sum of stage times".padEnd(20)} ${"".padEnd(8)} ${total.toFixed(2)}\n`,
	);
}

const startedAt = performance.now();
const selected = parseGroup();
armChildSignals();
let exitCode = 0;
try {
	const staticStages = stages.filter((stage) => stage.group === "static");
	const e2eStages = stages.filter((stage) => stage.group === "e2e");
	const results: Result[] = [];

	if (selected === "all" || selected === "static") {
		results.push(...(await runPool(staticStages, staticConcurrency)));
	}

	const staticFailed = results.some((result) => result.code !== 0);
	if (selected === "all" || selected === "e2e") {
		if (selected === "all" && staticFailed) {
			for (const stage of e2eStages) {
				const skipped: Result = {
					name: stage.name,
					code: 1,
					seconds: 0,
					output: "skipped because a static stage failed\n",
					skipped: true,
				};
				results.push(skipped);
				printResult(skipped);
			}
		} else {
			results.push(...(await runPool(e2eStages, 1)));
		}
	}

	printSummary(results);
	process.stdout.write(
		`wall                 ${((performance.now() - startedAt) / 1000).toFixed(2)}s\n`,
	);
	const failed = results.filter(
		(result) => !result.skipped && result.code !== 0,
	);
	if (failed.length > 0) {
		process.stderr.write(
			`Failed stages: ${failed.map((result) => result.name).join(", ")}\n`,
		);
		exitCode = 1;
	} else if (results.some((result) => result.skipped)) {
		exitCode = 1;
	}
} finally {
	disarmChildSignals();
}
if (exitCode !== 0) process.exit(exitCode);
