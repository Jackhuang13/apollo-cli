export class AgentObserveError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgentObserveError";
	}
}

type HostRequest = (op: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown>>;

function _getHostRequest(): HostRequest {
	const g = globalThis as { host_request?: HostRequest };
	if (typeof g.host_request !== "function") {
		throw new AgentObserveError("agent_observe requires an active REPL cell with host_request support.");
	}
	return g.host_request;
}

/** List the full nuclear family: parent, siblings, children, active or not. */
export async function list_agents(): Promise<Record<string, unknown>> {
	return _getHostRequest()("agent_observe.list");
}

/** Read one live session summary by active id, session id/name, or suffix. */
export async function get(target: string): Promise<Record<string, unknown>> {
	if (typeof target !== "string") {
		throw new AgentObserveError(`target must be a string, got ${typeof target}`);
	}
	return _getHostRequest()("agent_observe.get", { target });
}

/** Read bounded recent message previews from an active session. */
export async function recent(
	target: string,
	limit = 8,
	max_chars = 800,
): Promise<Record<string, unknown>> {
	if (typeof target !== "string") {
		throw new AgentObserveError(`target must be a string, got ${typeof target}`);
	}
	if (typeof limit !== "number") {
		throw new AgentObserveError(`limit must be a number, got ${typeof limit}`);
	}
	if (typeof max_chars !== "number") {
		throw new AgentObserveError(`max_chars must be a number, got ${typeof max_chars}`);
	}
	return _getHostRequest()("agent_observe.recent", { target, limit, max_chars });
}

export const agent_observe = {
	list_agents,
	get,
	recent,
	AgentObserveError,
};
export const agentObserve = agent_observe;
export default agent_observe;
