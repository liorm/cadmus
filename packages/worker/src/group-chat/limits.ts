/**
 * Pure limits for bot group chats.
 *
 * @mention routing for 3+ members lives in `parseMentions` and
 * `routeGroupRecipients`. `message_bot` `readOnly` narrows the target tool
 * gate (`readOnlyGroupToolNames` in `@cadmus/contract/tools`). It does not
 * grow a second turn engine. Fire-and-forget uses this same driver.
 *
 * Wake turns (the originating chat's new turn after a fire-and-forget chat
 * ends) start a fresh peer-action budget: the budget is keyed by that turn's
 * root request id, not the root that created the group. They inherit the
 * group's hop chain, so a target already on that chain is still a cycle.
 * A woken caller therefore cannot message the peer it just heard from, and
 * the peer cannot be reached again on that chain. New bots still stop at
 * depth 3. That caps A↔B ping-pong without a second limiter.
 */

export const MAX_HOP_DEPTH = 3;
export const MAX_PEER_ACTIONS = 5;
export const MAX_GROUP_TURNS = 10;
export const DEFAULT_GROUP_REPLY_MS = 120_000;
export const DEFAULT_GROUP_OVERALL_MS = 10 * 60_000;

export type HopAdmit =
	| { ok: true; chain: string[]; depth: number }
	| { ok: false; reason: "cycle" | "depth"; message: string };

/**
 * Hop depth counts message_bot calls from the root human turn.
 * The chain lists every bot already involved, starting with the caller.
 * Depth 3 is allowed. Depth 4 is refused. A target already on the chain
 * is a cycle (A → B → A).
 */
export function admitHop(
	chain: readonly string[],
	caller: string,
	target: string,
): HopAdmit {
	const base = chain.includes(caller) ? [...chain] : [...chain, caller];
	if (base.includes(target)) {
		return {
			ok: false,
			reason: "cycle",
			message: `Refusing to message @${target}: already on the hop chain (${[...base, target].join(" -> ")}).`,
		};
	}
	const next = [...base, target];
	const depth = next.length - 1;
	if (depth > MAX_HOP_DEPTH) {
		return {
			ok: false,
			reason: "depth",
			message: `Refusing hop depth ${depth}: max depth is ${MAX_HOP_DEPTH}.`,
		};
	}
	return { ok: true, chain: next, depth };
}

/**
 * Admit every target of one `message_bot` call onto the hop chain.
 * Each target is one hop, in call order, using `admitHop`. A fresh call
 * can therefore name at most `MAX_HOP_DEPTH` targets (caller + 3 bots).
 * A target already on the chain, including an earlier target of this call,
 * is a cycle. Depth 4 is still refused.
 */
export function admitTargets(
	chain: readonly string[],
	caller: string,
	targets: readonly string[],
): HopAdmit {
	let current: readonly string[] = chain;
	let hop: HopAdmit = {
		ok: false,
		reason: "depth",
		message: "At least one target bot is required.",
	};
	for (const target of targets) {
		hop = admitHop(current, caller, target);
		if (!hop.ok) return hop;
		current = hop.chain;
	}
	return hop;
}

/**
 * One `message_bot` call spends one peer action. That call creates one
 * chat and sends its opening message; those are not charged separately,
 * and later routed replies are bounded by the per-chat turn cap.
 * The 6th action in a root turn is refused.
 */
export function reservePeerAction(
	used: number,
	limit = MAX_PEER_ACTIONS,
): { ok: true; used: number } | { ok: false; message: string } {
	const next = used + 1;
	if (next > limit) {
		return {
			ok: false,
			message: `Refusing peer action ${next}: at most ${limit} peer actions (chats created plus messages sent) per root turn.`,
		};
	}
	return { ok: true, used: next };
}

/**
 * Slugs mentioned as `@slug`, in order of first appearance.
 * A slug is `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`. Duplicates are dropped.
 * The `@` must start the text or follow a non-slug character, so `a@b`
 * is not a mention.
 */
export function parseMentions(text: string): string[] {
	const found: string[] = [];
	const seen = new Set<string>();
	const pattern = /(^|[^A-Za-z0-9_-])@([A-Za-z0-9][A-Za-z0-9_-]{0,63})/g;
	for (const match of text.matchAll(pattern)) {
		const slug = match[2];
		if (!slug || seen.has(slug)) continue;
		seen.add(slug);
		found.push(slug);
	}
	return found;
}

/**
 * Two members: the other bot replies to every post. Mention text is ignored.
 * More than two members: only mentioned member slugs reply, in order of
 * first mention. The sender mentioning itself is ignored. Unknown slugs
 * are ignored.
 * `opening: true` is only for the caller's opening post. When that post
 * mentions no other member, every other member is treated as mentioned,
 * in member-list order. A later post that mentions nobody gets no replies.
 */
export function routeGroupRecipients(
	members: readonly string[],
	fromBotId: string,
	text: string,
	options?: { opening?: boolean },
): string[] {
	if (members.length === 2) {
		return members.filter((id) => id !== fromBotId);
	}
	if (members.length < 2) return [];
	const memberSet = new Set(members);
	const mentioned = parseMentions(text).filter(
		(id) => memberSet.has(id) && id !== fromBotId,
	);
	if (mentioned.length > 0) return mentioned;
	if (options?.opening) {
		return members.filter((id) => id !== fromBotId);
	}
	return [];
}

export function formatGroupInbound(
	topic: string,
	fromBotId: string,
	text: string,
): string {
	return `[group "${topic}" · from @${fromBotId}] ${text}`;
}

/**
 * Attributed input delivered to the caller's originating chat when a
 * fire-and-forget group chat completes. `ended` is the target's reply with
 * no extra status word. `capped` and `timed_out` keep the status on the line
 * so the woken turn can tell a finished reply from a watchdog or the cap.
 */
export function formatGroupWake(input: {
	topic: string;
	groupId: string;
	fromBotId: string;
	status: "ended" | "capped" | "timed_out";
	text: string;
}): string {
	const head = `[group "${input.topic}" · reply from @${input.fromBotId} · chat ${input.groupId}]`;
	if (input.status === "ended") return `${head} ${input.text}`.trim();
	return `${head} ${input.status}\n${input.text}`.trim();
}

export function resolveGroupTimeoutMs(
	raw: string | undefined,
	fallback: number,
): number {
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.floor(value), 50), 3_600_000);
}

export const GROUP_REPLY_OPEN = "[[group-reply]]";
export const GROUP_REPLY_CLOSE = "[[/group-reply]]";

/** Test seam. The body is posted as assistant text and is not executed on this turn. */
export function extractGroupReply(userText: string): string | undefined {
	const start = userText.indexOf(GROUP_REPLY_OPEN);
	if (start === -1) return undefined;
	const end = userText.indexOf(
		GROUP_REPLY_CLOSE,
		start + GROUP_REPLY_OPEN.length,
	);
	if (end === -1) return undefined;
	return userText.slice(start + GROUP_REPLY_OPEN.length, end).trim();
}
