import { useEffect, useLayoutEffect, useRef } from "react";

export const SCROLL_BOTTOM_THRESHOLD = 50;

export function isNearBottom(
	scrollHeight: number,
	scrollTop: number,
	clientHeight: number,
	threshold = SCROLL_BOTTOM_THRESHOLD,
): boolean {
	return scrollHeight - scrollTop - clientHeight <= threshold;
}

export function useAutoScroll<T extends HTMLElement = HTMLDivElement>(
	options: {
		threshold?: number;
		chatKey?: string;
		streamingActive?: boolean;
		hasNewUserMessage?: boolean;
	} = {},
) {
	const scrollRef = useRef<T | null>(null);
	const isAtBottomRef = useRef(true);
	const prevStreamingActiveRef = useRef(Boolean(options.streamingActive));
	const prevChatKeyRef = useRef(options.chatKey);
	const threshold = options.threshold ?? SCROLL_BOTTOM_THRESHOLD;

	if (options.chatKey !== prevChatKeyRef.current) {
		prevChatKeyRef.current = options.chatKey;
		isAtBottomRef.current = true;
	}
	if (!prevStreamingActiveRef.current && options.streamingActive) {
		isAtBottomRef.current = true;
	}
	prevStreamingActiveRef.current = Boolean(options.streamingActive);
	if (options.hasNewUserMessage) {
		isAtBottomRef.current = true;
	}

	const handleScroll = (event?: { currentTarget: T }) => {
		const el = event ? event.currentTarget : scrollRef.current;
		if (!el) return;
		isAtBottomRef.current = isNearBottom(
			el.scrollHeight,
			el.scrollTop,
			el.clientHeight,
			threshold,
		);
	};

	const scrollToBottom = () => {
		const el = scrollRef.current;
		if (!el) return;
		el.scrollTop = el.scrollHeight;
		isAtBottomRef.current = true;
	};

	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		if (isAtBottomRef.current) el.scrollTop = el.scrollHeight;
	});

	useEffect(() => {
		const el = scrollRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => {
			if (isAtBottomRef.current && scrollRef.current) {
				scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
			}
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	return { scrollRef, isAtBottomRef, handleScroll, scrollToBottom };
}
