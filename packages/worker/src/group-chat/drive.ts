import type { ChatRecord } from "../protocol.js";
import type {
	FamilyStore,
	GroupChatRecord,
	GroupMessage,
} from "../store/family-interface.js";
import {
	admitTargets,
	formatGroupInbound,
	formatGroupWake,
	MAX_GROUP_TURNS,
	reservePeerAction,
	routeGroupRecipients,
} from "./limits.js";

export class GroupReplyTimeout extends Error {
	constructor() {
		super("group reply timed out");
		this.name = "GroupReplyTimeout";
	}
}

export type GroupRunResult =
	| {
			ok: true;
			status: "pending";
			wait: false;
			groupId: string;
			topic: string;
			members: string[];
	  }
	| {
			ok: true;
			status: "ended" | "capped" | "timed_out";
			groupId: string;
			topic: string;
			members: string[];
			response?: string;
			transcript: { fromBotId: string; text: string; at: number }[];
	  }
	| { ok: false; error: string };

export interface GroupDriveDeps {
	store: FamilyStore;
	now(): number;
	replyMs: number;
	overallMs: number;
	createChat(input: {
		botId: string;
		key: string;
		title: string;
		harvest: false;
		listed: false;
	}): Promise<ChatRecord>;
	submitTurn(input: {
		chatKey: string;
		text: string;
		requestId: string;
		replyTimeoutMs: number;
	}): Promise<{ reply: string }>;
	abortChat(chatKey: string): Promise<void>;
	syncAlarm(): Promise<void>;
	log(message: string, fields?: Record<string, unknown>): void;
}

export interface GroupDriveInput {
	taskId: string;
	callerBotId: string;
	/** Single-target form. Ignored when `targetBotIds` is non-empty. */
	targetBotId?: string;
	/** One group chat with the caller plus every id, in this order. */
	targetBotIds?: readonly string[];
	topic: string;
	text: string;
	originChatKey: string;
	/** Default true. False opens the chat and returns before any reply. */
	wait?: boolean;
	/**
	 * When true, each target member session is offered only memory and
	 * knowledge read tools. Default false.
	 */
	readOnly?: boolean;
}

/**
 * Durable driver for a group chat.
 * Re-entering with the same task id resumes the stored record and does not
 * post the opening message again.
 *
 * `wait: false` (fire-and-forget) posts the opening message and returns
 * `{ status: "pending" }` without running turns. A background task calls
 * `driveGroupChat` for the same loop this function runs when waiting.
 * With two members, the first non-empty target reply ends the chat.
 * With more than two members, the chat ends when every bot that was
 * mentioned in the opening message has posted once (if the opening mentions
 * nobody, every target is in that set). Cap and watchdog still end it.
 * The caller does not take turns in fire-and-forget mode.
 */
export async function runGroupMessage(
	deps: GroupDriveDeps,
	input: GroupDriveInput,
): Promise<GroupRunResult> {
	const existing = deps.store.groups.getByTaskId(input.taskId);
	if (!existing) {
		const created = await openGroup(deps, input);
		if (created.ok === false) return created;
	}
	const group = requireGroup(deps, input.taskId);
	if (group.mode === "forget") {
		postOpening(deps, group);
		return {
			ok: true,
			status: "pending",
			wait: false,
			groupId: group.id,
			topic: group.topic,
			members: group.members,
		};
	}
	return drive(deps, input.taskId);
}

/** Resume a fire-and-forget chat that is still open. No-op once it has ended. */
export async function driveGroupChat(
	deps: GroupDriveDeps,
	taskId: string,
): Promise<GroupRunResult> {
	const group = requireGroup(deps, taskId);
	if (group.mode !== "forget") return resultOf(deps, group);
	if (group.status !== "open") return resultOf(deps, group);
	postOpening(deps, group);
	return drive(deps, taskId);
}

export function groupWakeText(
	deps: Pick<GroupDriveDeps, "store">,
	group: GroupChatRecord,
): string {
	const transcript = deps.store.groups.listMessages(group.id);
	const peer =
		group.members.length > 2
			? (transcript
					.filter((line) => line.fromBotId !== group.creatorBotId)
					.at(-1)?.fromBotId ??
				group.members.find((id) => id !== group.creatorBotId) ??
				group.creatorBotId)
			: (group.members.find((id) => id !== group.creatorBotId) ??
				group.creatorBotId);
	const body =
		group.endResponse ??
		transcript.map((line) => `@${line.fromBotId}: ${line.text}`).join("\n");
	const status = group.status === "open" ? "ended" : group.status;
	return formatGroupWake({
		topic: group.topic,
		groupId: group.id,
		fromBotId: peer,
		status,
		text: body,
	});
}

async function openGroup(
	deps: GroupDriveDeps,
	input: GroupDriveInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const topic = input.topic.trim();
	if (!topic) return { ok: false, error: "topic is required." };
	const targets = normalizeTargets(input);
	if (targets.length === 0) {
		return { ok: false, error: "botId (or slug) is required." };
	}
	if (targets.includes(input.callerBotId)) {
		return { ok: false, error: "Refusing to message the calling bot." };
	}
	for (const targetBotId of targets) {
		const target = deps.store.bots.getBot(targetBotId);
		if (!target) {
			return {
				ok: false,
				error: `Bot '${targetBotId}' not found in this family.`,
			};
		}
	}
	const caller = deps.store.bots.getBot(input.callerBotId);
	if (!caller) {
		return { ok: false, error: "Conversation is not bound to a bot." };
	}

	const parent = deps.store.groups.findByMemberKey(input.originChatKey);
	const rootRequestId =
		parent?.group.rootRequestId ??
		deps.store.chats.getTurnRoot(input.originChatKey) ??
		input.taskId;
	// Member sessions keep the parent group's chain. A wake turn on the
	// originating chat is not a member session; its chain is stored under
	// that turn's root request id and its peer-action counter starts at 0.
	const priorChain =
		parent?.group.hopChain ?? deps.store.groups.hopContext(rootRequestId) ?? [];
	const hop = admitTargets(priorChain, input.callerBotId, targets);
	if (!hop.ok) return { ok: false, error: hop.message };

	const used = deps.store.groups.peerActions(rootRequestId);
	const reserved = reservePeerAction(used);
	if (!reserved.ok) return { ok: false, error: reserved.message };

	const now = deps.now();
	const taskKey = String(input.taskId);
	const id = `grp_${taskKey.replace(/[^a-zA-Z0-9]/g, "").slice(-24) || crypto.randomUUID().slice(0, 12)}`;
	const members = [input.callerBotId, ...targets];
	const delivered: Record<string, number> = {};
	for (const botId of members) delivered[botId] = 0;
	const group: GroupChatRecord = {
		id,
		topic,
		members,
		creatorBotId: input.callerBotId,
		rootRequestId,
		humanReadOnly: true,
		...(input.readOnly === true ? { toolsReadOnly: true } : {}),
		hopChain: hop.chain,
		turnCount: 0,
		status: "open",
		mode: input.wait === false ? "forget" : "wait",
		originChatKey: parent?.group.originChatKey ?? input.originChatKey,
		taskId: input.taskId,
		openingText: input.text,
		createdAt: now,
		updatedAt: now,
		overallDeadline: now + deps.overallMs,
		delivered,
	};
	deps.store.groups.insert(group);
	deps.store.groups.setPeerActions(rootRequestId, reserved.used);

	const callerKey = memberKey(group.id, input.callerBotId);
	await deps.createChat({
		botId: input.callerBotId,
		key: callerKey,
		title: `Group: ${topic}`,
		harvest: false,
		listed: false,
	});
	deps.store.groups.bindMember(
		group.id,
		input.callerBotId,
		callerKey,
		"caller",
	);
	for (const targetBotId of targets) {
		const targetKey = memberKey(group.id, targetBotId);
		await deps.createChat({
			botId: targetBotId,
			key: targetKey,
			title: `Group: ${topic}`,
			harvest: false,
			listed: false,
		});
		deps.store.groups.bindMember(group.id, targetBotId, targetKey, "member");
	}
	deps.log("group chat opened", {
		group: group.id,
		fromBot: input.callerBotId,
		toBots: targets,
		chargedTo: input.callerBotId,
		depth: hop.depth,
		peerActions: reserved.used,
		mode: group.mode,
		toolsReadOnly: group.toolsReadOnly === true,
	});
	return { ok: true };
}

function normalizeTargets(input: GroupDriveInput): string[] {
	const listed = (input.targetBotIds ?? [])
		.map((id) => id.trim())
		.filter((id) => id.length > 0);
	const source =
		listed.length > 0
			? listed
			: input.targetBotId?.trim()
				? [input.targetBotId.trim()]
				: [];
	const unique: string[] = [];
	for (const id of source) {
		if (!unique.includes(id)) unique.push(id);
	}
	return unique;
}

function postOpening(deps: GroupDriveDeps, group: GroupChatRecord): void {
	if (deps.store.groups.listMessages(group.id).length > 0) return;
	deps.store.groups.appendMessage(
		group.id,
		group.creatorBotId,
		group.openingText,
		deps.now(),
	);
}

function memberKey(groupId: string, botId: string): string {
	return `gmem:${groupId}:${botId}`;
}

export async function drive(
	deps: GroupDriveDeps,
	taskId: string,
): Promise<GroupRunResult> {
	let group = requireGroup(deps, taskId);
	postOpening(deps, group);

	const passed = new Set<string>();
	while (group.status === "open") {
		const now = deps.now();
		if (now >= group.overallDeadline) {
			return finish(deps, group, "timed_out");
		}
		if (group.turnCount >= MAX_GROUP_TURNS) {
			return finish(deps, group, "capped");
		}
		const messages = deps.store.groups.listMessages(group.id);
		const turn = selectTurn(group, messages, passed);
		if (!turn) {
			return waitForWatchdog(deps, group);
		}
		const { next, pending } = turn;
		const text = pending
			.map((message) =>
				formatGroupInbound(group.topic, message.fromBotId, message.text),
			)
			.join("\n\n");
		group.turnCount += 1;
		const replyBudget = deps.replyMs;
		group.replyDeadline = now + replyBudget;
		group.updatedAt = now;
		const deliveredThrough = pending[pending.length - 1]?.seq ?? 0;
		group.delivered = { ...group.delivered, [next]: deliveredThrough };
		deps.store.groups.save(group);
		await deps.syncAlarm();

		const requestId = `group:${group.id}:turn:${group.turnCount}`;
		const sessionKey = memberKey(group.id, next);
		let reply = "";
		try {
			const settled = await deps.submitTurn({
				chatKey: sessionKey,
				text,
				requestId,
				replyTimeoutMs: replyBudget,
			});
			reply = settled.reply.trim();
		} catch (error) {
			if (error instanceof GroupReplyTimeout) {
				return finish(deps, reload(deps, group.id), "timed_out");
			}
			const current = reload(deps, group.id);
			if (
				current.status === "timed_out" ||
				deps.now() >= (current.replyDeadline ?? current.overallDeadline)
			) {
				return finish(deps, current, "timed_out");
			}
			throw error;
		}

		group = reload(deps, group.id);
		if (group.status !== "open") return resultOf(deps, group);
		if (group.endResponse !== undefined) {
			return finish(deps, group, "ended");
		}
		group.replyDeadline = undefined;
		group.updatedAt = deps.now();
		deps.store.groups.save(group);
		if (reply) {
			passed.clear();
			const posted = reply.startsWith("echo(")
				? reply.replaceAll("[tool:", "[cited-tool:")
				: reply;
			deps.store.groups.appendMessage(group.id, next, posted, deps.now());
			// Fire-and-forget does not keep the caller parked in this chat.
			// Two members: the target's first real reply is the result.
			// More than two: wait until every opening recipient has posted
			// once (see `openingRecipients`). Later turns are not run after
			// that. Cap and watchdog still end the chat sooner.
			if (group.mode === "forget" && next !== group.creatorBotId) {
				const done = reload(deps, group.id);
				const messages = deps.store.groups.listMessages(done.id);
				if (
					done.members.length <= 2 ||
					openingRecipients(done).every((botId) =>
						messages.some((message) => message.fromBotId === botId),
					)
				) {
					done.endResponse =
						done.members.length <= 2
							? posted
							: messages
									.filter((message) => message.fromBotId !== done.creatorBotId)
									.map((message) => `@${message.fromBotId}: ${message.text}`)
									.join("\n");
					deps.store.groups.save(done);
					return finish(deps, done, "ended");
				}
			}
		} else {
			passed.add(next);
		}
		group = reload(deps, group.id);
		if (group.turnCount >= MAX_GROUP_TURNS) {
			return finish(deps, group, "capped");
		}
	}
	return resultOf(deps, group);
}

/**
 * Recipients of the latest undelivered post speak one at a time, in mention
 * order. With two members that is the other member. A turn with no final
 * text is a pass: nothing is posted, and with two members the other member
 * speaks once. When both have passed, the chat stays open for the watchdog.
 * With more than two members a pass just moves on to the next mention.
 */
function selectTurn(
	group: GroupChatRecord,
	messages: readonly GroupMessage[],
	passed: ReadonlySet<string>,
): { next: string; pending: GroupMessage[] } | undefined {
	const routed = nextSpeaker(group, messages);
	if (routed) {
		const openingSeq = messages[0]?.seq;
		const pending = messages.filter((message) => {
			if (message.fromBotId === routed) return false;
			if (message.seq <= (group.delivered[routed] ?? 0)) return false;
			return messageRecipients(
				group,
				message,
				message.seq === openingSeq,
			).includes(routed);
		});
		if (pending.length > 0) return { next: routed, pending };
	}
	if (group.mode === "forget" && routed === group.creatorBotId) {
		return undefined;
	}
	if (
		group.mode === "forget" ||
		group.members.length !== 2 ||
		passed.size !== 1
	) {
		return undefined;
	}
	const other = group.members.find((botId) => !passed.has(botId));
	if (!other) return undefined;
	const pending = messages.filter((message) => message.fromBotId !== other);
	const context = pending.length > 0 ? pending : messages.slice(-1);
	if (context.length === 0) return undefined;
	return { next: other, pending: context };
}

async function waitForWatchdog(
	deps: GroupDriveDeps,
	group: GroupChatRecord,
): Promise<GroupRunResult> {
	const deadline = Math.min(
		group.replyDeadline ?? group.overallDeadline,
		group.overallDeadline,
	);
	while (deps.now() < deadline) {
		const current = reload(deps, group.id);
		if (current.status !== "open") return resultOf(deps, current);
		const remaining = deadline - deps.now();
		await new Promise((resolve) =>
			setTimeout(resolve, Math.min(200, remaining)),
		);
	}
	const current = reload(deps, group.id);
	if (current.status !== "open") return resultOf(deps, current);
	return finish(deps, current, "timed_out");
}

function messageRecipients(
	group: GroupChatRecord,
	message: GroupMessage,
	opening: boolean,
): string[] {
	let recipients = routeGroupRecipients(
		group.members,
		message.fromBotId,
		message.text,
		{ opening },
	);
	// The caller is not sitting in a fire-and-forget chat.
	if (group.mode === "forget") {
		recipients = recipients.filter((botId) => botId !== group.creatorBotId);
	}
	return recipients;
}

function nextSpeaker(
	group: GroupChatRecord,
	messages: readonly GroupMessage[],
): string | undefined {
	const openingSeq = messages[0]?.seq;
	for (const message of messages) {
		const next = messageRecipients(
			group,
			message,
			message.seq === openingSeq,
		).find((botId) => message.seq > (group.delivered[botId] ?? 0));
		if (next) return next;
	}
	return undefined;
}

/** Bots treated as mentioned on the opening post. See `routeGroupRecipients`. */
function openingRecipients(group: GroupChatRecord): string[] {
	return routeGroupRecipients(
		group.members,
		group.creatorBotId,
		group.openingText,
		{ opening: true },
	);
}

function finish(
	deps: GroupDriveDeps,
	group: GroupChatRecord,
	status: "ended" | "capped" | "timed_out",
): GroupRunResult {
	const current = reload(deps, group.id);
	if (current.status === "open") {
		current.status = status;
		current.replyDeadline = undefined;
		current.updatedAt = deps.now();
		deps.store.groups.save(current);
	}
	deps.log("group chat finished", {
		group: current.id,
		status: current.status,
		chargedTo: current.creatorBotId,
		turns: current.turnCount,
	});
	return resultOf(deps, current);
}

function resultOf(
	deps: GroupDriveDeps,
	group: GroupChatRecord,
): GroupRunResult {
	const transcript = deps.store.groups
		.listMessages(group.id)
		.map((message) => ({
			fromBotId: message.fromBotId,
			text: message.text,
			at: message.at,
		}));
	return {
		ok: true,
		status: group.status === "open" ? "ended" : group.status,
		groupId: group.id,
		topic: group.topic,
		members: group.members,
		...(group.endResponse !== undefined ? { response: group.endResponse } : {}),
		transcript,
	};
}

function requireGroup(deps: GroupDriveDeps, taskId: string): GroupChatRecord {
	const group = deps.store.groups.getByTaskId(taskId);
	if (!group) throw new Error(`Group task '${taskId}' is missing.`);
	return group;
}

function reload(deps: GroupDriveDeps, id: string): GroupChatRecord {
	const group = deps.store.groups.getById(id);
	if (!group) throw new Error(`Group '${id}' is missing.`);
	return group;
}
