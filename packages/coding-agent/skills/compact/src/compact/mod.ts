export class CompactError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CompactError";
	}
}

export interface CompactOptions {
	instructions?: string;
}

export interface CompactStatus {
	tokens: number | null;
	context_window: number;
	contextWindow: number;
	percent: number | null;
	threshold_percent: number;
	thresholdPercent: number;
	should_compact: boolean;
	shouldCompact: boolean;
	compacting: boolean;
	pending_request: boolean;
	pendingRequest: boolean;
}

export interface CompactRequestResult {
	status: string;
	tokens: number | null;
	context_window: number;
	contextWindow: number;
	percent: number | null;
	instructions?: string;
}

function _getHostRequest(): (payload: Record<string, unknown>, timeout?: number) => Promise<Record<string, unknown>> {
	const g = globalThis as {
		host_request?: (payload: Record<string, unknown>, timeout?: number) => Promise<Record<string, unknown>>;
	};
	if (typeof g.host_request !== "function") {
		throw new CompactError("compact skill requires an active REPL cell with host_request support.");
	}
	return g.host_request;
}

export async function status(): Promise<CompactStatus> {
	const hostReq = _getHostRequest();
	const reply = await hostReq({ op: "compact_status" });
	if (reply.ok === false) {
		throw new CompactError(String(reply.error ?? "compact_status failed"));
	}
	const tokens = typeof reply.tokens === "number" ? reply.tokens : null;
	const contextWindow = typeof reply.context_window === "number" ? reply.context_window : 0;
	const percent = typeof reply.percent === "number" ? reply.percent : null;
	const thresholdPercent = typeof reply.threshold_percent === "number" ? reply.threshold_percent : 80;
	const shouldCompact = Boolean(reply.should_compact);
	const compacting = Boolean(reply.compacting);
	const pendingRequest = Boolean(reply.pending_request);

	return {
		tokens,
		context_window: contextWindow,
		contextWindow,
		percent,
		threshold_percent: thresholdPercent,
		thresholdPercent,
		should_compact: shouldCompact,
		shouldCompact,
		compacting,
		pending_request: pendingRequest,
		pendingRequest,
	};
}

export async function request(
	instructionsOrOptions?: string | CompactOptions,
): Promise<CompactRequestResult> {
	const instructions =
		typeof instructionsOrOptions === "string"
			? instructionsOrOptions.trim()
			: instructionsOrOptions?.instructions?.trim();

	const hostReq = _getHostRequest();
	const payload: Record<string, unknown> = { op: "compact_request" };
	if (instructions) {
		payload.instructions = instructions;
	}
	const reply = await hostReq(payload);
	if (reply.ok === false) {
		throw new CompactError(String(reply.error ?? "compact_request failed"));
	}

	const contextWindow = typeof reply.context_window === "number" ? reply.context_window : 0;
	return {
		status: String(reply.status ?? "scheduled"),
		tokens: typeof reply.tokens === "number" ? reply.tokens : null,
		context_window: contextWindow,
		contextWindow,
		percent: typeof reply.percent === "number" ? reply.percent : null,
		instructions: typeof reply.instructions === "string" ? reply.instructions : instructions,
	};
}

export const compact = Object.assign(
	async function compactFn(instructionsOrOptions?: string | CompactOptions): Promise<CompactRequestResult> {
		return await request(instructionsOrOptions);
	},
	{
		status,
		request,
		CompactError,
	},
);

export default compact;
