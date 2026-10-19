import { afterEach, describe, expect, it, vi } from "vitest";

// Set the runtime `mcp` global before the skill module is evaluated so the
// import-time capture path is exercised.
const runtimeMcp = vi.hoisted(() => {
	const instance = {
		call_tool: async (server: string, tool: string, args?: Record<string, unknown>) => ({ server, tool, args }),
		list_tools: async (server: string) => [{ server }],
	};
	(globalThis as Record<string, unknown>).mcp = instance;
	return instance;
});

import mcpSkill, { get_mcp } from "../skills/mcp/src/mcp/mod.js";

describe("mcp skill identity (AC-35)", () => {
	const original = (globalThis as Record<string, unknown>).mcp;

	afterEach(() => {
		(globalThis as Record<string, unknown>).mcp = original;
	});

	it("default export is the runtime instance captured at import time", () => {
		expect(mcpSkill).toBe(runtimeMcp);
	});

	it("survives the bootstrap rebinding globalThis.mcp to the default export", async () => {
		// The IScript bootstrap does `globalThis[skillName] = mod.default`.
		(globalThis as Record<string, unknown>).mcp = mcpSkill;
		expect((globalThis as Record<string, unknown>).mcp).toBe(runtimeMcp);
		const live = (
			globalThis as unknown as {
				mcp: { call_tool: (s: string, t: string, a?: Record<string, unknown>) => Promise<unknown> };
			}
		).mcp;
		const result = await live.call_tool("exa", "web_search_exa", { query: "x" });
		expect(result).toEqual({ server: "exa", tool: "web_search_exa", args: { query: "x" } });
	});

	it("get_mcp returns the live global instance", () => {
		expect(get_mcp()).toBe(runtimeMcp);
	});
});
