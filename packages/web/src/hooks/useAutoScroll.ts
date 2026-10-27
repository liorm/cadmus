import { useEffect, useLayoutEffect, useRef } from "react";

export const useIsomorphicLayoutEffect =
	typeof window !== "undefined" ? useLayoutEffect : useEffect;

export const SCROLL_BOTTOM_THRESHOLD = 50;

/**
 * Returns true if the scroll position is within threshold pixels of the container bottom.
 */
export function isNearBottom(
	scrollHeight: number,
	scrollTop: number,
	clientHeight: number,
	threshold = SCROLL_BOTTOM_THRESHOLD,
): boolean {
	return scrollHeight - scrollTop - clientHeight <= threshold;
}

export interface UseAutoScrollOptions {
	/**
	 * Pixel threshold from the bottom to still be considered "at bottom".
	 * Defaults to 50.
	 */
	threshold?: number;
	/**
	 * Unique identifier for the active chat/conversation.
	 * When this changes, scroll position is reset to the bottom.
	 */
	chatKey?: string;
	/**
	 * Whether a streaming turn is actively in progress.
	 * When this transitions from false to true, scroll position is reset to the bottom.
	 */
	streamingActive?: boolean;
	/**
	 * Flag indicating a new user message was submitted.
	 * Resets scroll position to the bottom so user sees their new prompt.
	 */
	hasNewUserMessage?: boolean;
}

export function useAutoScroll<T extends HTMLElement = HTMLDivElement>(
	options: UseAutoScrollOptions = {},
) {
	const scrollRef = useRef<T | null>(null);
	const isAtBottomRef = useRef<boolean>(true);
	const prevStreamingActiveRef = useRef<boolean>(
		Boolean(options.streamingActive),
	);
	const prevChatKeyRef = useRef<string | undefined>(options.chatKey);
	const threshold = options.threshold ?? SCROLL_BOTTOM_THRESHOLD;

	// Reset to bottom when switching chats
	if (options.chatKey !== prevChatKeyRef.current) {
		prevChatKeyRef.current = options.chatKey;
		isAtBottomRef.current = true;
	}

	// Reset to bottom when a turn begins streaming
	if (!prevStreamingActiveRef.current && options.streamingActive) {
		isAtBottomRef.current = true;
	}
	prevStreamingActiveRef.current = Boolean(options.streamingActive);

	// Reset to bottom if a new user message was submitted
	if (options.hasNewUserMessage) {
		isAtBottomRef.current = true;
	}

	const handleScroll = (e?: React.UIEvent<T>) => {
		const el = e ? e.currentTarget : scrollRef.current;
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

	// On layout/render, if we are at the bottom, keep scroll pinned to bottom
	useIsomorphicLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		if (isAtBottomRef.current) {
			el.scrollTop = el.scrollHeight;
		}
	});

	// Handle window or container resizing
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

	return {
		scrollRef,
		isAtBottomRef,
		handleScroll,
		scrollToBottom,
	};
}
