import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import orchestration_heartbeat from "../skills/orchestration-heartbeat/src/orchestration_heartbeat/mod.js";
import rlm_heartbeat, { create, list, update } from "../skills/rlm-heartbeat/src/rlm_heartbeat/mod.js";

describe("rlm_heartbeat skill (AC-30, AC-32)", () => {
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

	it("list() issues rlm_heartbeat.list with include_inactive", async () => {
		hr.mockResolvedValue({ heartbeats: [] });
		await list(true);
		expect(hr).toHaveBeenCalledWith("rlm_heartbeat.list", { include_inactive: true });
		await list();
		expect(hr).toHaveBeenLastCalledWith("rlm_heartbeat.list", { include_inactive: false });
	});

	it("create() issues rlm_heartbeat.create with all fields", async () => {
		hr.mockResolvedValue({ heartbeat: { id: "h1" } });
		await create("check", "5m", "tests", "follow_up");
		expect(hr).toHaveBeenCalledWith("rlm_heartbeat.create", {
			instruction: "check",
			interval: "5m",
			label: "tests",
			delivery_mode: "follow_up",
		});
	});

	it("create() rejects an invalid delivery_mode", async () => {
		await expect(create("check", undefined, undefined, "bogus" as never)).rejects.toThrow(/delivery_mode/);
	});

	it("update() issues rlm_heartbeat.update", async () => {
		hr.mockResolvedValue({ heartbeat: { id: "h1" } });
		await update("h1", undefined, undefined, undefined, "pause");
		expect(hr).toHaveBeenCalledWith("rlm_heartbeat.update", { id: "h1", status: "pause" });
	});

	it("delete() issues rlm_heartbeat.delete", async () => {
		hr.mockResolvedValue({ heartbeat: null });
		await rlm_heartbeat.delete("h1");
		expect(hr).toHaveBeenCalledWith("rlm_heartbeat.delete", { id: "h1" });
	});

	it("exposes list/create/update/delete and orchestration_heartbeat is self-contained (AC-32)", () => {
		expect(orchestration_heartbeat).not.toBe(rlm_heartbeat);
		for (const obj of [rlm_heartbeat, orchestration_heartbeat]) {
			for (const fn of ["list", "create", "update", "delete"]) {
				expect(typeof obj[fn as "list"]).toBe("function");
			}
		}
	});
});
