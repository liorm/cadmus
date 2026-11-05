/**
 * Per-project typechecks. Same projects as the previous `typecheck` script.
 * `bun check` (root tsconfig: worker source and e2e) and `tsc -p packages/worker`
 * both see the worker, on different checkers, so both stay.
 * Two at a time matches a 2-vCPU runner. Output is buffered per project.
 */
import { spawn } from "node:child_process";
import {
	armChildSignals,
	disarmChildSignals,
	reportChildClose,
	trackChild,
} from "./child-close.ts";

type Project = {
	name: string;
	cmd: string[];
	weight: number;
};

const projects: Project[] = [
	{
		name: "web-app",
		cmd: ["bun", "run", "--cwd", "packages/web-app", "typecheck"],
		weight: 70,
	},
	{
		name: "worker",
		cmd: ["bunx", "tsc", "-p", "packages/worker/tsconfig.json", "--noEmit"],
		weight: 40,
	},
	{ name: "bun check", cmd: ["bun", "check"], weight: 30 },
	{
		name: "contract",
		cmd: ["bunx", "tsc", "-p", "packages/contract/tsconfig.json", "--noEmit"],
		weight: 10,
	},
	{
		name: "daemon",
		cmd: ["bunx", "tsc", "-p", "packages/daemon/tsconfig.json", "--noEmit"],
		weight: 10,
	},
	{
		name: "cli",
		cmd: ["bunx", "tsc", "-p", "packages/cli/tsconfig.json", "--noEmit"],
		weight: 10,
	},
];

const concurrency = 2;

type Result = {
	name: string;
	code: number;
	seconds: number;
	output: string;
};

function run(project: Project): Promise<Result> {
	const started = performance.now();
	return new Promise((resolve) => {
		const child = spawn(project.cmd[0] ?? "bun", project.cmd.slice(1), {
			stdio: ["ignore", "pipe", "pipe"],
		});
		trackChild(child);
		const chunks: Buffer[] = [];
		child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
		const finish = (code: number, output: string): void => {
			resolve({
				name: project.name,
				code,
				seconds: (performance.now() - started) / 1000,
				output,
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
	const status = result.code === 0 ? "ok" : "FAIL";
	process.stdout.write(
		`\n──── typecheck ${result.name} (${status}, ${result.seconds.toFixed(2)}s) ────\n`,
	);
	const text = result.output.trimEnd();
	if (text.length > 0) {
		for (const line of text.split("\n")) {
			process.stdout.write(`[typecheck ${result.name}] ${line}\n`);
		}
	}
}

async function runPool(list: Project[]): Promise<Result[]> {
	const queue = [...list].sort((a, b) => b.weight - a.weight);
	const results: Result[] = [];
	let cursor = 0;
	async function worker(): Promise<void> {
		while (cursor < queue.length) {
			const project = queue[cursor];
			cursor += 1;
			if (!project) return;
			const result = await run(project);
			results.push(result);
			printResult(result);
		}
	}
	const workers = Math.min(concurrency, queue.length);
	await Promise.all(Array.from({ length: workers }, () => worker()));
	return results;
}

armChildSignals();
let exitCode = 0;
try {
	const results = await runPool(projects);
	const order = new Map(
		projects.map((project, index) => [project.name, index]),
	);
	results.sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0));
	const failed = results.filter((result) => result.code !== 0);
	process.stdout.write("\nTypecheck\n");
	process.stdout.write("project      status   seconds\n");
	for (const result of results) {
		const status = result.code === 0 ? "ok" : "FAIL";
		process.stdout.write(
			`${result.name.padEnd(12)} ${status.padEnd(8)} ${result.seconds.toFixed(2)}\n`,
		);
	}
	if (failed.length > 0) {
		process.stderr.write(
			`Failed typechecks: ${failed.map((result) => result.name).join(", ")}\n`,
		);
		exitCode = 1;
	}
} finally {
	disarmChildSignals();
}
if (exitCode !== 0) process.exit(exitCode);
