export type HeartbeatStatusUpdate = "pause" | "resume";
export type HeartbeatDeliveryMode = "steer" | "follow_up";

export interface HeartbeatInfo {
	id: string;
	instruction: string;
	interval?: string | null;
	label?: string | null;
	status?: string;
	delivery_mode?: string | null;
	[key: string]: unknown;
}

type HostRequest = (op: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown>>;

function _getHostRequest(): HostRequest {
	const g = globalThis as { host_request?: HostRequest };
	if (typeof g.host_request !== "function") {
		throw new Error("rlm_heartbeat requires an active REPL cell with host_request support.");
	}
	return g.host_request;
}

function _normalizeDeliveryMode(delivery_mode: HeartbeatDeliveryMode | undefined): HeartbeatDeliveryMode | undefined {
	if (delivery_mode === undefined) return undefined;
	if (delivery_mode !== "steer" && delivery_mode !== "follow_up") {
		throw new Error('delivery_mode must be "steer", "follow_up", or undefined');
	}
	return delivery_mode;
}

/** List internal RLM heartbeats for the current agent session. */
export async function list(include_inactive = false): Promise<Record<string, unknown>> {
	if (typeof include_inactive !== "boolean") {
		throw new Error(`include_inactive must be a boolean, got ${typeof include_inactive}`);
	}
	return _getHostRequest()("rlm_heartbeat.list", { include_inactive });
}

/** Create an internal recurring heartbeat for the current agent session. */
export async function create(
	instruction: string,
	interval?: string,
	label?: string,
	delivery_mode?: HeartbeatDeliveryMode,
): Promise<Record<string, unknown>> {
	if (typeof instruction !== "string") {
		throw new Error(`instruction must be a string, got ${typeof instruction}`);
	}
	const payload: Record<string, unknown> = { instruction };
	if (interval !== undefined) {
		if (typeof interval !== "string") throw new Error(`interval must be a string when provided, got ${typeof interval}`);
		payload.interval = interval;
	}
	if (label !== undefined) {
		if (typeof label !== "string") throw new Error(`label must be a string when provided, got ${typeof label}`);
		payload.label = label;
	}
	const normalized = _normalizeDeliveryMode(delivery_mode);
	if (normalized !== undefined) payload.delivery_mode = normalized;
	return _getHostRequest()("rlm_heartbeat.create", payload);
}

/** Update one internal RLM heartbeat for the current agent session. */
export async function update(
	id: string,
	instruction?: string,
	interval?: string,
	label?: string,
	status?: HeartbeatStatusUpdate,
	delivery_mode?: HeartbeatDeliveryMode,
): Promise<Record<string, unknown>> {
	if (typeof id !== "string") {
		throw new Error(`id must be a string, got ${typeof id}`);
	}
	const payload: Record<string, unknown> = { id };
	if (instruction !== undefined) {
		if (typeof instruction !== "string") throw new Error(`instruction must be a string when provided, got ${typeof instruction}`);
		payload.instruction = instruction;
	}
	if (interval !== undefined) {
		if (typeof interval !== "string") throw new Error(`interval must be a string when provided, got ${typeof interval}`);
		payload.interval = interval;
	}
	if (label !== undefined) {
		if (typeof label !== "string") throw new Error(`label must be a string when provided, got ${typeof label}`);
		payload.label = label;
	}
	if (status !== undefined) {
		if (status !== "pause" && status !== "resume") {
			throw new Error('status must be "pause", "resume", or undefined');
		}
		payload.status = status;
	}
	const normalized = _normalizeDeliveryMode(delivery_mode);
	if (normalized !== undefined) payload.delivery_mode = normalized;
	return _getHostRequest()("rlm_heartbeat.update", payload);
}

/** Cancel one internal RLM heartbeat for the current agent session. */
async function deleteHeartbeat(id: string): Promise<Record<string, unknown>> {
	if (typeof id !== "string") {
		throw new Error(`id must be a string, got ${typeof id}`);
	}
	return _getHostRequest()("rlm_heartbeat.delete", { id });
}

export const rlm_heartbeat = {
	list,
	create,
	update,
	delete: deleteHeartbeat,
};
export default rlm_heartbeat;
