import {
	encodeWire,
	type ParsedDaemonFrame,
	parseDaemonFrame,
	transportFailure,
	type WireFailure,
	type WireOutputEvent,
} from "./wire.js";

export interface WireCall {
	id?: string;
	method: string;
	args?: unknown;
	generation: number;
	timeoutMs?: number;
	onOutput?: (event: WireOutputEvent) => void;
	onWatch?: (change: unknown) => void;
}

export type WireCallResult =
	| { ok: true; value: unknown }
	| { ok: false; error: WireFailure["error"] };

interface Pending {
	method: string;
	generation: number;
	resolve: (result: WireCallResult) => void;
	onOutput?: (event: WireOutputEvent) => void;
	onWatch?: (change: unknown) => void;
	timer?: ReturnType<typeof setTimeout>;
}

/**
 * Correlates one socket's requests with daemon replies.
 * The owner sends bytes and feeds inbound text here.
 */
export class WireCaller {
	private readonly pending = new Map<string, Pending>();
	private readonly watches = new Map<string, (change: unknown) => void>();

	constructor(private readonly sendText: (text: string) => boolean) {}

	call(input: WireCall): Promise<WireCallResult> {
		const id = input.id ?? crypto.randomUUID();
		const sent = this.sendText(
			encodeWire({
				id,
				method: input.method,
				...(input.args !== undefined ? { args: input.args } : {}),
			}),
		);
		if (!sent) {
			return Promise.resolve({
				ok: false,
				error: transportFailure(input.method),
			});
		}
		return new Promise((resolve) => {
			const pending: Pending = {
				method: input.method,
				generation: input.generation,
				resolve,
				onOutput: input.onOutput,
				onWatch: input.onWatch,
			};
			if (input.timeoutMs !== undefined && input.timeoutMs > 0) {
				pending.timer = setTimeout(() => {
					if (!this.pending.has(id)) return;
					this.pending.delete(id);
					resolve({ ok: false, error: transportFailure(input.method) });
				}, input.timeoutMs);
			}
			this.pending.set(id, pending);
		});
	}

	followWatch(id: string, onChange: (change: unknown) => void): void {
		this.watches.set(id, onChange);
	}

	unfollowWatch(id: string): void {
		this.watches.delete(id);
	}

	ingest(text: string): ParsedDaemonFrame {
		const parsed = parseDaemonFrame(text);
		if (parsed.action === "output") {
			this.pending.get(parsed.frame.id)?.onOutput?.(parsed.frame);
			return parsed;
		}
		if (parsed.action === "watch") {
			const change = parsed.frame.change;
			this.pending.get(parsed.frame.id)?.onWatch?.(change);
			this.watches.get(parsed.frame.id)?.(change);
			return parsed;
		}
		if (parsed.action !== "result") return parsed;
		const pending = this.pending.get(parsed.frame.id);
		if (!pending) return parsed;
		this.pending.delete(parsed.frame.id);
		if (pending.timer) clearTimeout(pending.timer);
		if (parsed.frame.ok) {
			pending.resolve({ ok: true, value: parsed.frame.value });
		} else {
			pending.resolve({ ok: false, error: parsed.frame.error });
		}
		return parsed;
	}

	failGeneration(generation: number): void {
		for (const [id, pending] of [...this.pending.entries()]) {
			if (pending.generation !== generation) continue;
			this.pending.delete(id);
			if (pending.timer) clearTimeout(pending.timer);
			pending.resolve({ ok: false, error: transportFailure(pending.method) });
		}
	}

	hasGeneration(generation: number): boolean {
		for (const pending of this.pending.values()) {
			if (pending.generation === generation) return true;
		}
		return false;
	}
}
