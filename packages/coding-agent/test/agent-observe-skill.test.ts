import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import agent_observe, {
	AgentObserveError,
	get,
	list_agents,
	recent,
} from "../skills/agent-observe/src/agent_observe/mod.js";

describe("agent_observe skill (AC-31)", () => {
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

	it("list_agents() issues agent_observe.list", async () => {
		hr.mockResolvedValue({ agents: [{ id: "p" }] });
		expect(await list_agents()).toEqual({ agents: [{ id: "p" }] });
		expect(hr).toHaveBeenCalledWith("agent_observe.list");
	});

	it("get() issues agent_observe.get with {target}", async () => {
		hr.mockResolvedValue({ agent: { id: "x" } });
		await get("parent");
		expect(hr).toHaveBeenCalledWith("agent_observe.get", { target: "parent" });
	});

	it("get() rejects a non-string target", async () => {
		await expect(get(5 as unknown as string)).rejects.toThrow(AgentObserveError);
	});

	it("recent() issues agent_observe.recent with defaults", async () => {
		hr.mockResolvedValue({ messages: [] });
		await recent("sibling");
		expect(hr).toHaveBeenCalledWith("agent_observe.recent", { target: "sibling", limit: 8, max_chars: 800 });
	});

	it("recent() passes explicit limit and max_chars", async () => {
		hr.mockResolvedValue({ messages: [] });
		await recent("child", 3, 100);
		expect(hr).toHaveBeenCalledWith("agent_observe.recent", { target: "child", limit: 3, max_chars: 100 });
	});

	it("namespace exposes list_agents/get/recent", () => {
		expect(agent_observe.list_agents).toBe(list_agents);
		expect(agent_observe.get).toBe(get);
		expect(agent_observe.recent).toBe(recent);
	});
});
