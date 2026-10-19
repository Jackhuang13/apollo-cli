// Thin typed client over the generic host bridge (`host_request`). All goal
// state lives in the TypeScript host; these functions only marshal requests.

interface HostRequestFn {
	(requestType: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

function hostRequest(): HostRequestFn {
	const g = globalThis as { host_request?: HostRequestFn };
	if (typeof g.host_request !== "function") {
		throw new Error("goal.* must be called inside a kernel with the rlm runtime.");
	}
	return g.host_request;
}

export type GoalStatus = "active" | "paused" | "budget_limited" | "complete" | "error";

export interface SerializedGoal {
	goal_id?: string;
	objective: string;
	status: GoalStatus;
	token_budget?: number;
	tokens_used: number;
	time_used_seconds: number;
	created_at?: number;
	updated_at?: number;
}

export interface GoalHostResponse {
	goal: SerializedGoal | null;
	remaining_tokens: number | null;
	completion_budget_report: string | null;
}

function asGoalResponse(value: Record<string, unknown>): GoalHostResponse {
	const record = value as unknown as Partial<GoalHostResponse>;
	return {
		goal: record.goal ?? null,
		remaining_tokens: record.remaining_tokens ?? null,
		completion_budget_report: record.completion_budget_report ?? null,
	};
}

/** Read the current thread goal (null goal when none is set). */
export async function get(): Promise<GoalHostResponse> {
	return asGoalResponse(await hostRequest()("goal.get"));
}

/**
 * Start a new active thread goal. Fails while a goal is still pending (active,
 * paused, or budget-limited); a completed or errored goal is replaced. Only
 * create a goal when the user or system/developer instructions explicitly ask
 * for a persistent long-running goal.
 */
export async function create(
	objective: string,
	tokenBudget?: number,
): Promise<GoalHostResponse> {
	if (typeof objective !== "string" || !objective.trim()) {
		throw new TypeError("objective must be a non-empty string.");
	}
	if (tokenBudget !== undefined && (typeof tokenBudget !== "number" || !Number.isInteger(tokenBudget))) {
		throw new TypeError("token_budget must be an integer.");
	}
	const payload: Record<string, unknown> = { objective };
	if (tokenBudget !== undefined) {
		payload["token_budget"] = tokenBudget;
	}
	return asGoalResponse(await hostRequest()("goal.create", payload));
}

/**
 * Mark the existing thread goal achieved. Use only when the objective has
 * actually been achieved and no required work remains. Pause, resume, and
 * budget-limit transitions are controlled by the user and the host.
 */
export async function complete(): Promise<GoalHostResponse> {
	return asGoalResponse(await hostRequest()("goal.complete"));
}

export const goal = { get, create, complete };
export default goal;
