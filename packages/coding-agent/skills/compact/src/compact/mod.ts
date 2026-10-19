export class CompactError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CompactError";
	}
}

export interface CompactStatus {
	tokens: number | null;
	context_window: number | null;
	percent: number | null;
	scheduled: boolean;
}

export interface CompactRunResult {
	scheduled: boolean;
	reason?: string;
	note?: string;
}

type HostRequest = (op: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown>>;

function _getHostRequest(): HostRequest {
	const g = globalThis as { host_request?: HostRequest };
	if (typeof g.host_request !== "function") {
		throw new CompactError("compact skill requires an active REPL cell with host_request support.");
	}
	return g.host_request;
}

/** Read current context usage from the host. */
export async function status(): Promise<CompactStatus> {
	const reply = await _getHostRequest()("compact.status");
	return {
		tokens: typeof reply.tokens === "number" ? reply.tokens : null,
		context_window: typeof reply.context_window === "number" ? reply.context_window : null,
		percent: typeof reply.percent === "number" ? reply.percent : null,
		scheduled: reply.scheduled === true,
	};
}

/** Schedule context compaction; it runs when the current turn ends. */
export async function run(instructions?: string): Promise<CompactRunResult> {
	if (instructions !== undefined && typeof instructions !== "string") {
		throw new CompactError(`instructions must be a string when provided, got ${typeof instructions}`);
	}
	const payload: Record<string, unknown> = {};
	if (instructions !== undefined) {
		payload.instructions = instructions;
	}
	const reply = await _getHostRequest()("compact.run", payload);
	return {
		scheduled: reply.scheduled === true,
		reason: typeof reply.reason === "string" ? reply.reason : undefined,
		note: typeof reply.note === "string" ? reply.note : undefined,
	};
}

export const request = run;

export const compact = Object.assign(
	async function compactFn(instructions?: string): Promise<CompactRunResult> {
		return await run(instructions);
	},
	{ status, run, request, CompactError },
);
export default compact;
