export interface HarnessOptions {
	global_?: boolean;
	global?: boolean;
	[key: string]: unknown;
}

export interface RefinementOptions {
	evidence?: string;
	outcome?: string;
	global_?: boolean;
	global?: boolean;
}

export interface RefineRunResult {
	scheduled: boolean;
	reason?: string;
	note?: string;
}

export interface RefineStatus {
	pending: boolean;
	in_flight: boolean;
}

type HostRequest = (op: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown>>;

/**
 * The real HarnessState surface exposed on `globalThis.harness`. Only the
 * methods that exist on the host HarnessState are wrapped here.
 */
interface HarnessLike {
	list(kind?: string | null, options?: HarnessOptions): unknown;
	create_memory(title: string, content: string, options?: HarnessOptions): unknown;
	update_memory(id: string, title: string, content: string, options?: HarnessOptions): unknown;
	delete_memory(id: string, options?: HarnessOptions): boolean;
	create_prompt_note(title: string, content: string, options?: HarnessOptions): unknown;
	update_prompt_note(id: string, title: string, content: string, options?: HarnessOptions): unknown;
	delete_prompt_note(id: string, options?: HarnessOptions): boolean;
	create_skill(title: string, content: string, options?: HarnessOptions): unknown;
	update_skill(id: string, title: string, content: string, options?: HarnessOptions): unknown;
	delete_skill(id: string, options?: HarnessOptions): boolean;
	create_subagent(title: string, content: string, options?: HarnessOptions): unknown;
	update_subagent(id: string, title: string, content: string, options?: HarnessOptions): unknown;
	delete_subagent(id: string, options?: HarnessOptions): boolean;
	record_refinement(trigger: string, changes: string[] | string, options?: RefinementOptions): unknown;
	overview(options?: HarnessOptions): string;
	search(query: string, kind?: string | null, limit?: number, options?: HarnessOptions): unknown;
}

function _getHarness(): HarnessLike {
	const g = globalThis as { harness?: HarnessLike };
	if (!g.harness) {
		throw new Error("harness is not available in globalThis.");
	}
	return g.harness;
}

function _getHostRequest(): HostRequest {
	const g = globalThis as { host_request?: HostRequest };
	if (typeof g.host_request !== "function") {
		throw new Error("refine skill requires an active REPL cell with host_request support.");
	}
	return g.host_request;
}

/**
 * Schedule continual harness refinement. It runs when the current turn ends;
 * the harness applies changes, rebuilds the system prompt, and resumes you.
 * Set `global_` to target the cross-session store; omit for local.
 */
export async function run(instructions?: string, global_ = false): Promise<RefineRunResult> {
	if (instructions !== undefined && typeof instructions !== "string") {
		throw new Error(`instructions must be a string when provided, got ${typeof instructions}`);
	}
	if (typeof global_ !== "boolean") {
		throw new Error(`global_ must be a boolean, got ${typeof global_}`);
	}
	const payload: Record<string, unknown> = {};
	if (instructions !== undefined) payload.instructions = instructions;
	if (global_) payload.global = true;
	const reply = await _getHostRequest()("refine.run", payload);
	return {
		scheduled: reply.scheduled === true,
		reason: typeof reply.reason === "string" ? reply.reason : undefined,
		note: typeof reply.note === "string" ? reply.note : undefined,
	};
}

/** Read refine state: whether a refine is queued or currently applying. */
export async function status(): Promise<RefineStatus> {
	const reply = await _getHostRequest()("refine.status");
	return {
		pending: reply.pending === true,
		in_flight: reply.in_flight === true,
	};
}

export function list(kind?: string | null, options?: HarnessOptions): unknown {
	return _getHarness().list(kind, options);
}
export function create_memory(title: string, content: string, options?: HarnessOptions): unknown {
	return _getHarness().create_memory(title, content, options);
}
export function update_memory(id: string, title: string, content: string, options?: HarnessOptions): unknown {
	return _getHarness().update_memory(id, title, content, options);
}
export function delete_memory(id: string, options?: HarnessOptions): boolean {
	return _getHarness().delete_memory(id, options);
}
export function create_prompt_note(title: string, content: string, options?: HarnessOptions): unknown {
	return _getHarness().create_prompt_note(title, content, options);
}
export function update_prompt_note(id: string, title: string, content: string, options?: HarnessOptions): unknown {
	return _getHarness().update_prompt_note(id, title, content, options);
}
export function delete_prompt_note(id: string, options?: HarnessOptions): boolean {
	return _getHarness().delete_prompt_note(id, options);
}
export function create_skill(title: string, content: string, options?: HarnessOptions): unknown {
	return _getHarness().create_skill(title, content, options);
}
export function update_skill(id: string, title: string, content: string, options?: HarnessOptions): unknown {
	return _getHarness().update_skill(id, title, content, options);
}
export function delete_skill(id: string, options?: HarnessOptions): boolean {
	return _getHarness().delete_skill(id, options);
}
export function create_subagent(title: string, content: string, options?: HarnessOptions): unknown {
	return _getHarness().create_subagent(title, content, options);
}
export function update_subagent(id: string, title: string, content: string, options?: HarnessOptions): unknown {
	return _getHarness().update_subagent(id, title, content, options);
}
export function delete_subagent(id: string, options?: HarnessOptions): boolean {
	return _getHarness().delete_subagent(id, options);
}
export function record_refinement(trigger: string, changes: string[] | string, options?: RefinementOptions): unknown {
	return _getHarness().record_refinement(trigger, changes, options);
}
export function overview(options?: HarnessOptions): string {
	return _getHarness().overview(options);
}
export function search(query: string, kind?: string | null, limit?: number, options?: HarnessOptions): unknown {
	return _getHarness().search(query, kind, limit, options);
}

export const refine = {
	run,
	status,
	list,
	create_memory,
	update_memory,
	delete_memory,
	create_prompt_note,
	update_prompt_note,
	delete_prompt_note,
	create_skill,
	update_skill,
	delete_skill,
	create_subagent,
	update_subagent,
	delete_subagent,
	record_refinement,
	overview,
	search,
};
export default refine;
