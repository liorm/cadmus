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
	retry: () => void;
} {
	const [snap, setSnap] = useState<LoadSnapshot<T>>(() => initialLoad(scope));
	const [attempt, setAttempt] = useState(0);
	const loaderRef = useRef(loader);
	loaderRef.current = loader;

	useEffect(() => {
		let cancelled = false;
		void attempt;
		setSnap((prev) => beginLoad(prev, scope));
		void loaderRef
			.current()
			.then((data) => {
				if (!cancelled) setSnap((prev) => finishLoad(prev, scope, data));
			})
			.catch((err: unknown) => {
				if (!cancelled) {
					setSnap((prev) =>
						failLoad(prev, scope, loadErrorMessage(err, "Could not load")),
					);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [attempt, scope]);

	const visible = snap.scope === scope ? snap : initialLoad<T>(scope);
	const retry = useCallback(() => setAttempt((value) => value + 1), []);
	return {
		phase: visible.phase,
		data: visible.data,
		error: visible.error,
		retry,
	};
}
