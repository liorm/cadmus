/**
 * Shared child-process bookkeeping for the check runners.
 *
 * `reportChildClose` is pure. A delivered signal is a failure and is appended
 * as its own output line. The tracker forwards SIGINT and SIGTERM to children
 * we still have open, then the parent exits 130 or 143.
 */
import type { ChildProcess } from "node:child_process";

export function reportChildClose(
	output: string,
	code: number | null,
	signal: string | null,
): { code: number; output: string } {
	if (signal) {
		const line = `killed by signal ${signal}\n`;
		const text =
			output.length === 0 || output.endsWith("\n")
				? output + line
				: `${output}\n${line}`;
		return { code: 1, output: text };
	}
	return { code: code ?? 1, output };
}

const running = new Set<ChildProcess>();

export function trackChild(child: ChildProcess): void {
	running.add(child);
	const forget = (): void => {
		running.delete(child);
	};
	child.once("close", forget);
	child.once("error", () => {
		// Spawn failures have no pid and may not emit `close`.
		if (child.pid === undefined) forget();
	});
}

function signalChildren(signal: NodeJS.Signals): void {
	for (const child of [...running]) {
		try {
			child.kill(signal);
		} catch {
			// The pid is already gone.
		}
	}
}

function stopParent(signal: "SIGINT" | "SIGTERM"): void {
	signalChildren(signal);
	process.exit(signal === "SIGINT" ? 130 : 143);
}

const onSigint = (): void => stopParent("SIGINT");
const onSigterm = (): void => stopParent("SIGTERM");

let armed = false;

export function armChildSignals(): void {
	if (armed) return;
	process.on("SIGINT", onSigint);
	process.on("SIGTERM", onSigterm);
	armed = true;
}

/** Drop signal listeners. Signal any child that is still recorded. */
export function disarmChildSignals(): void {
	if (armed) {
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
		armed = false;
	}
	signalChildren("SIGTERM");
}
