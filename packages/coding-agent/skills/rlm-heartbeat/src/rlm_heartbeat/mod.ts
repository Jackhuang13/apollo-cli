export interface HeartbeatCheckResult {
	total: number;
	running: number;
	completed: number;
	failed: number;
	subagents: unknown[];
}

export async function check_subagents(): Promise<HeartbeatCheckResult> {
	const g = globalThis as {
		rlm?: { list_subagents?: () => Promise<unknown[]> };
		host_request?: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
	};
	let subagents: unknown[] = [];
	if (g.rlm && typeof g.rlm.list_subagents === "function") {
		subagents = await g.rlm.list_subagents();
	} else if (typeof g.host_request === "function") {
		const reply = await g.host_request({ op: "rlm_list_subagents" });
		subagents = (reply.subagents as unknown[]) ?? (reply.result as unknown[]) ?? [];
	}

	let running = 0;
	let completed = 0;
	let failed = 0;
	for (const item of subagents) {
		const state = String((item as Record<string, unknown>)?.state ?? (item as Record<string, unknown>)?.status ?? "").toLowerCase();
		if (state === "running" || state === "active" || state === "pending") {
			running++;
		} else if (state === "failed" || state === "error" || state === "errored") {
			failed++;
		} else if (state === "completed" || state === "done" || state === "idle") {
			completed++;
		}
	}

	return {
		total: subagents.length,
		running,
		completed,
		failed,
		subagents,
	};
}
export const checkSubagents = check_subagents;

export async function report_progress(note: string, metadata: Record<string, unknown> = {}): Promise<void> {
	const g = globalThis as {
		rlm?: { progress_note?: (text: string, metadata?: Record<string, unknown>) => Promise<void> };
	};
	if (g.rlm && typeof g.rlm.progress_note === "function") {
		await g.rlm.progress_note(note, metadata);
	}
}
export const reportProgress = report_progress;

export const rlm_heartbeat = {
	check_subagents,
	checkSubagents,
	report_progress,
	reportProgress,
};
export const orchestration_heartbeat = rlm_heartbeat;
export default rlm_heartbeat;
