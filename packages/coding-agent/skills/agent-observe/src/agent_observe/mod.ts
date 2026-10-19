export class AgentObserveError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgentObserveError";
	}
}

function _getHostRequest(): (payload: Record<string, unknown>, timeout?: number) => Promise<Record<string, unknown>> {
	const g = globalThis as {
		host_request?: (payload: Record<string, unknown>, timeout?: number) => Promise<Record<string, unknown>>;
	};
	if (typeof g.host_request !== "function") {
		throw new AgentObserveError("agent_observe requires an active REPL cell with host_request support.");
	}
	return g.host_request;
}

export async function list_subagents(): Promise<unknown[]> {
	const reply = await _getHostRequest()({ op: "rlm_list_subagents" });
	if (reply.ok === false) {
		throw new AgentObserveError(String(reply.error ?? "rlm_list_subagents failed"));
	}
	return (reply.subagents as unknown[]) ?? (reply.result as unknown[]) ?? [];
}
export const listSubagents = list_subagents;

export async function inspect_subagent(
	subagentId: string,
	options: { tail?: number; include_transcript?: boolean } = {},
): Promise<Record<string, unknown>> {
	const id = String(subagentId ?? "").trim();
	if (!id) {
		throw new AgentObserveError("inspect_subagent(subagentId) requires a non-empty subagentId.");
	}
	const reply = await _getHostRequest()({
		op: "rlm_inspect_subagent",
		subagent_id: id,
		...options,
	});
	if (reply.ok === false) {
		throw new AgentObserveError(String(reply.error ?? "rlm_inspect_subagent failed"));
	}
	return (reply.result as Record<string, unknown>) ?? reply;
}
export const inspectSubagent = inspect_subagent;

export const agent_observe = {
	list_subagents,
	listSubagents,
	inspect_subagent,
	inspectSubagent,
	AgentObserveError,
};
export const agentObserve = agent_observe;
export default agent_observe;
