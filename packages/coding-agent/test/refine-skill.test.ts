import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import refine, {
	create_memory,
	overview,
	record_refinement,
	run,
	search,
	status,
} from "../skills/refine/src/refine/mod.js";

describe("refine skill (AC-33, AC-34)", () => {
	let hr: ReturnType<typeof vi.fn>;
	let harness: Record<string, ReturnType<typeof vi.fn>>;
	const originalHr = (globalThis as Record<string, unknown>).host_request;
	const originalHarness = (globalThis as Record<string, unknown>).harness;

	beforeEach(() => {
		hr = vi.fn();
		(globalThis as Record<string, unknown>).host_request = hr;
		harness = {};
		for (const m of [
			"list",
			"create_memory",
			"update_memory",
			"delete_memory",
			"create_prompt_note",
			"update_prompt_note",
			"delete_prompt_note",
			"create_skill",
			"update_skill",
			"delete_skill",
			"create_subagent",
			"update_subagent",
			"delete_subagent",
			"record_refinement",
			"overview",
			"search",
		]) {
			harness[m] = vi.fn();
		}
		(globalThis as Record<string, unknown>).harness = harness;
	});

	afterEach(() => {
		if (originalHr === undefined) delete (globalThis as Record<string, unknown>).host_request;
		else (globalThis as Record<string, unknown>).host_request = originalHr;
		if (originalHarness === undefined) delete (globalThis as Record<string, unknown>).harness;
		else (globalThis as Record<string, unknown>).harness = originalHarness;
	});

	it("run() issues refine.run with instructions and global (AC-34)", async () => {
		hr.mockResolvedValue({ scheduled: true, note: "n" });
		const r = await run("tighten policy", true);
		expect(hr).toHaveBeenCalledWith("refine.run", { instructions: "tighten policy", global: true });
		expect(r).toEqual({ scheduled: true, note: "n" });
	});

	it("run() omits global when false and sends empty payload", async () => {
		hr.mockResolvedValue({ scheduled: false, reason: "idle" });
		await run();
		expect(hr).toHaveBeenCalledWith("refine.run", {});
	});

	it("status() issues refine.status (AC-34)", async () => {
		hr.mockResolvedValue({ pending: true, in_flight: false });
		expect(await status()).toEqual({ pending: true, in_flight: false });
		expect(hr).toHaveBeenCalledWith("refine.status");
	});

	it("wraps only real HarnessState methods (AC-33)", () => {
		create_memory("t", "c", { global_: true });
		expect(harness.create_memory).toHaveBeenCalledWith("t", "c", { global_: true });
		record_refinement("why", ["a"], { global_: true });
		expect(harness.record_refinement).toHaveBeenCalledWith("why", ["a"], { global_: true });
		harness.overview.mockReturnValue("OV");
		expect(overview()).toBe("OV");
		harness.search.mockReturnValue("SR");
		expect(search("q")).toBe("SR");
		expect(harness.search).toHaveBeenCalledWith("q", undefined, undefined, undefined);
		const keys = Object.keys(refine);
		for (const fake of ["upsert_rule", "list_rules", "get_preferences", "update_workflow_prompt", "snapshot"]) {
			expect(keys).not.toContain(fake);
		}
	});
});
