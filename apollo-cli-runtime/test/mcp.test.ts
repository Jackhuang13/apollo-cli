import test from "node:test";
import assert from "node:assert/strict";
import {
	describeTool,
	listPlugins,
	McpCredentialsUnavailable,
	McpDiscoveryError,
	McpStartupError,
	McpToolError,
	searchPlugins,
	searchTools,
} from "../src/rlm/mcp.ts";

test("mcp exports standard error classes", () => {
	assert.equal(new McpStartupError("startup fail").name, "McpStartupError");
	assert.equal(new McpDiscoveryError("disc fail").name, "McpDiscoveryError");
	assert.equal(new McpCredentialsUnavailable("cred fail").name, "McpCredentialsUnavailable");
	assert.equal(new McpToolError("tool fail").name, "McpToolError");
});

test("mcp validates parameters on search plugins and tools", async () => {
	await assert.rejects(async () => searchPlugins("test", -1), { message: /limit must be an integer/ });
	await assert.rejects(async () => searchPlugins("test", 9999), { message: /limit must be an integer/ });
	await assert.rejects(async () => searchTools("test", null, 0), { message: /limit must be an integer/ });
});

test("mcp validates listPlugins limit parameter", async () => {
	await assert.rejects(async () => listPlugins({ limit: -5 }), { message: /limit must be an integer/ });
});

test("mcp describes non-existent tool gracefully or throws descriptive error", async () => {
	await assert.rejects(async () => describeTool("non_existent_server", "tool"));
});
