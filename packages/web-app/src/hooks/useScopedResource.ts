import { useCallback, useEffect, useRef, useState } from "react";
import {
	beginLoad,
	failLoad,
	finishLoad,
	initialLoad,
	type LoadPhase,
	type LoadSnapshot,
	loadErrorMessage,
} from "@/lib/load-state";

export function useScopedResource<T>(
	scope: string,
	loader: () => Promise<T>,
): {
	phase: LoadPhase;
	data: T | undefined;
	error: string | undefined;
	/**
	 * Id of the newest requested read (retry() ids, 0 for the first) whose result
	 * was published for this scope. A read started by retry() id N, or any later
	 * one, publishes an id >= N; an older in-flight read publishes its own
	 * smaller id.
	 */
	completed: number;
	/** Requests a fresh read and returns its request id. */
	retry: () => number;
	/** Updates ready cached data for the current scope in place. */
	patch: (updater: (prev: T) => T) => void;
} {
	const [snap, setSnap] = useState<LoadSnapshot<T>>(() => initialLoad(scope));
	const [attempt, setAttempt] = useState(0);
	const [done, setDone] = useState<{ scope: string; id: number }>({
		scope,
		id: -1,
	});
	const requestRef = useRef(0);
	const loaderRef = useRef(loader);
	loaderRef.current = loader;

	useEffect(() => {
		let cancelled = false;
		const id = attempt;
		setSnap((prev) => beginLoad(prev, scope));
		void loaderRef
			.current()
			.then((data) => {
				if (!cancelled) {
					setSnap((prev) => finishLoad(prev, scope, data));
					setDone((prev) =>
						prev.scope === scope && prev.id > id ? prev : { scope, id },
					);
				}
			})
			.catch((err: unknown) => {
				if (!cancelled) {
					setSnap((prev) =>
						failLoad(prev, scope, loadErrorMessage(err, "Could not load")),
					);
					setDone((prev) =>
						prev.scope === scope && prev.id > id ? prev : { scope, id },
					);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [attempt, scope]);

	const visible = snap.scope === scope ? snap : initialLoad<T>(scope);
	const retry = useCallback(() => {
		// The id is taken synchronously, so a read still in flight from an
		// earlier request can never satisfy this one.
		requestRef.current += 1;
		setAttempt(requestRef.current);
		return requestRef.current;
	}, []);
	const patch = useCallback(
		(updater: (prev: T) => T) => {
			setSnap((prev) =>
				prev.scope === scope &&
				prev.phase === "ready" &&
				prev.data !== undefined
					? finishLoad(prev, scope, updater(prev.data))
					: prev,
			);
		},
		[scope],
	);
	return {
		phase: visible.phase,
		data: visible.data,
		error: visible.error,
		completed: done.scope === scope ? done.id : -1,
		retry,
		patch,
	};
}
