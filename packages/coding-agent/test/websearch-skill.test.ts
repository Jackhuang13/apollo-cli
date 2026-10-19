import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { code_context, search } from "../skills/websearch/src/websearch/mod.js";

describe("websearch uses server-first mcp.call_tool (AC-36)", () => {
	let callTool: ReturnType<typeof vi.fn>;
	const original = (globalThis as Record<string, unknown>).mcp;

	beforeEach(() => {
		callTool = vi.fn(async () => "ok");
		(globalThis as Record<string, unknown>).mcp = { call_tool: callTool };
	});

	afterEach(() => {
		if (original === undefined) {
			delete (globalThis as Record<string, unknown>).mcp;
		} else {
			(globalThis as Record<string, unknown>).mcp = original;
		}
	});

	it("search() calls call_tool(server, tool, args) with the exa server first", async () => {
		await search("quantum error correction", { num_results: 3 });
		expect(callTool).toHaveBeenCalledTimes(1);
		expect(callTool).toHaveBeenCalledWith(
			"exa",
			"web_search_exa",
			expect.objectContaining({ query: "quantum error correction", numResults: 3 }),
		);
	});

	it("code_context() calls call_tool with the exa server first", async () => {
		await code_context("how do I retry", { tokens_num: 250 });
		expect(callTool).toHaveBeenCalledWith(
			"exa",
			"get_code_context_exa",
			expect.objectContaining({ query: "how do I retry", tokensNum: 250 }),
		);
	});
});
