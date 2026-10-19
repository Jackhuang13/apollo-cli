import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import compact, { CompactError, request, run, status } from "../skills/compact/src/compact/mod.js";

describe("compact skill (AC-29)", () => {
	let hr: ReturnType<typeof vi.fn>;
	const original = (globalThis as Record<string, unknown>).host_request;

	beforeEach(() => {
		hr = vi.fn();
		(globalThis as Record<string, unknown>).host_request = hr;
	});
	afterEach(() => {
		if (original === undefined) {
			delete (globalThis as Record<string, unknown>).host_request;
		} else {
			(globalThis as Record<string, unknown>).host_request = original;
		}
	});

	it("status() issues compact.status and reads tokens/context_window/percent/scheduled", async () => {
		hr.mockResolvedValue({ tokens: 100, context_window: 200, percent: 50, scheduled: true });
		const s = await status();
		expect(hr).toHaveBeenCalledWith("compact.status");
		expect(s).toEqual({ tokens: 100, context_window: 200, percent: 50, scheduled: true });
	});

	it("status() nulls missing numeric fields", async () => {
		hr.mockResolvedValue({});
		expect(await status()).toEqual({ tokens: null, context_window: null, percent: null, scheduled: false });
	});

	it("run() issues compact.run with instructions", async () => {
		hr.mockResolvedValue({ scheduled: true, note: "n" });
		const r = await run("focus on X");
		expect(hr).toHaveBeenCalledWith("compact.run", { instructions: "focus on X" });
		expect(r).toEqual({ scheduled: true, note: "n" });
	});

	it("run() without instructions sends an empty payload", async () => {
		hr.mockResolvedValue({ scheduled: false, reason: "too short" });
		const r = await run();
		expect(hr).toHaveBeenCalledWith("compact.run", {});
		expect(r).toEqual({ scheduled: false, reason: "too short" });
	});

	it("run() rejects a non-string instructions value", async () => {
		await expect(run(123 as unknown as string)).rejects.toThrow(CompactError);
	});

	it("default export delegates to run and request is an alias", async () => {
		hr.mockResolvedValue({ scheduled: true, note: "n" });
		expect(await compact("x")).toEqual({ scheduled: true, note: "n" });
		expect(request).toBe(run);
	});
});
