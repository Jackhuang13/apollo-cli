import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import goal, { complete, create, get } from "../skills/goal/src/goal/mod.js";

interface Captured {
	op: string;
	payload?: Record<string, unknown>;
}

describe("goal skill host bridge (AC-37)", () => {
	let hostRequest: ReturnType<typeof vi.fn>;
	const captured: Captured[] = [];
	const original = (globalThis as Record<string, unknown>).host_request;

	beforeEach(() => {
		captured.length = 0;
		hostRequest = vi.fn(async (op: string, payload?: Record<string, unknown>) => {
			captured.push({ op, payload });
			return { goal: null, remaining_tokens: null, completion_budget_report: null };
		});
		(globalThis as Record<string, unknown>).host_request = hostRequest;
	});

	afterEach(() => {
		if (original === undefined) {
			delete (globalThis as Record<string, unknown>).host_request;
		} else {
			(globalThis as Record<string, unknown>).host_request = original;
		}
	});

	it("get() issues goal.get with no payload", async () => {
		await get();
		expect(captured).toEqual([{ op: "goal.get", payload: undefined }]);
	});

	it("create(objective) issues goal.create with the objective", async () => {
		await create("ship the fix");
		expect(captured).toEqual([{ op: "goal.create", payload: { objective: "ship the fix" } }]);
	});

	it("create(objective, budget) includes token_budget", async () => {
		await create("ship the fix", 120);
		expect(captured).toEqual([{ op: "goal.create", payload: { objective: "ship the fix", token_budget: 120 } }]);
	});

	it("complete() issues goal.complete", async () => {
		await complete();
		expect(captured).toEqual([{ op: "goal.complete", payload: undefined }]);
	});

	it("rejects an empty objective and a non-integer budget", async () => {
		await expect(create("   ")).rejects.toThrow(TypeError);
		await expect(create("x", 1.5)).rejects.toThrow(TypeError);
		expect(hostRequest).not.toHaveBeenCalled();
	});

	it("surfaces the host response and exposes the same API on the default export", async () => {
		hostRequest.mockResolvedValueOnce({
			goal: { objective: "x", status: "active", tokens_used: 1, time_used_seconds: 2 },
			remaining_tokens: 99,
			completion_budget_report: null,
		});
		const res = await goal.get();
		expect(res.remaining_tokens).toBe(99);
		expect(res.goal?.status).toBe("active");
		expect(typeof goal.create).toBe("function");
		expect(typeof goal.complete).toBe("function");
	});
});
