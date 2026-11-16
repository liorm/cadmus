/**
 * What the turn.completed event reports for a settled submission. Only a user
 * interrupt (unanswered with reason "aborted") is reported as unanswered, so
 * clients keep their failed marker. Every other settle stays "done", as before.
 */
export function completionOutcome(settled: {
	status: string;
	reason?: string;
}): { status: "done" } | { status: "unanswered"; reason: "aborted" } {
	if (settled.status === "unanswered" && settled.reason === "aborted") {
		return { status: "unanswered", reason: "aborted" };
	}
	return { status: "done" };
}
