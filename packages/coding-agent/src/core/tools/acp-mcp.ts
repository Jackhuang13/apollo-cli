import type { ToolDefinition } from "../extensions/types.js";
import type { ExecuteResult } from "../kernel/index.js";
import type { AcpMcpServerConfig } from "../mcp/acp-mcp-types.js";
import type { IpythonKernelProvisioner } from "./ipython.js";

// 48 keeps `mcp_list_tools_<name>` within providers' 64-char tool-name limits.
const ACP_MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,48}$/;

type Interpreter = "script";

export function acpMcpToolNames(servers: readonly AcpMcpServerConfig[]): string[] {
	const names: string[] = [];
	const seenServers = new Set<string>();
	for (const server of servers) {
		if (!ACP_MCP_SERVER_NAME_PATTERN.test(server.name)) {
			throw new Error(`Invalid ACP MCP server name: ${server.name}`);
		}
		if (seenServers.has(server.name)) {
			throw new Error(`Duplicate ACP MCP server: ${server.name}`);
		}
		seenServers.add(server.name);
		names.push(`mcp_list_tools_${server.name}`, `mcp_call_${server.name}`);
	}
	return names;
}

/**
 * Build the kernel code that lists a server's tools. The TS kernel returns the
 * last expression as the result, so it emits a `JSON.stringify(...)` expression.
 */
export function acpMcpListToolsCode(serverName: string, _interpreter: Interpreter = "script"): string {
	const quoted = JSON.stringify(serverName);
	return `JSON.stringify(await mcp.list_tools(${quoted}))`;
}

/** Build the kernel code that calls one tool on a server, per kernel dialect. */
export function acpMcpCallToolCode(
	serverName: string,
	tool: string,
	args: Record<string, unknown>,
	_interpreter: Interpreter = "script",
): string {
	const quoted = JSON.stringify(serverName);
	const toolQuoted = JSON.stringify(tool);
	const argsJson = JSON.stringify(args ?? {});
	return `JSON.stringify(await mcp.call_tool(${quoted}, ${toolQuoted}, ${argsJson}))`;
}

function executionResult(result: ExecuteResult) {
	let text = result.stdout;
	if (result.stderr) text += `${text ? "\n" : ""}${result.stderr}`;
	if (result.result) text += `${text ? "\n" : ""}${result.result}`;
	if (result.error) text += `${text ? "\n" : ""}${result.error.traceback.join("\n")}`;
	if (result.status !== "ok") {
		throw new Error(text || `MCP kernel execution ${result.status}`);
	}
	return {
		content: [{ type: "text" as const, text: text || "(empty)" }],
		details: {
			durationMs: result.durationMs,
			status: result.status,
			stdout: result.stdout,
			stderr: result.stderr,
			result: result.result,
		},
	};
}

async function executeMcpCode(
	provisioner: IpythonKernelProvisioner,
	buildCode: (interpreter: Interpreter) => string,
	signal: AbortSignal | undefined,
) {
	const manager = await provisioner.ensure(() => {}, signal);
	return executionResult(await manager.execute(buildCode(manager.interpreter), { signal }));
}

export function createAcpMcpToolDefinitions(
	servers: readonly AcpMcpServerConfig[],
	provisioner: IpythonKernelProvisioner,
): ToolDefinition[] {
	const names = acpMcpToolNames(servers);
	const definitions: ToolDefinition[] = [];
	for (const [index, server] of servers.entries()) {
		const listToolName = names[index * 2]!;
		const callToolName = names[index * 2 + 1]!;

		definitions.push({
			name: listToolName,
			label: `list tools from ${server.name}`,
			description:
				`List every tool the "${server.name}" MCP server exposes. ` +
				`Call this first, then use ${callToolName} to invoke a specific tool.`,
			parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
			execute: async (_toolCallId, _params, signal, _onUpdate, _ctx) => {
				return executeMcpCode(provisioner, (interpreter) => acpMcpListToolsCode(server.name, interpreter), signal);
			},
		});

		definitions.push({
			name: callToolName,
			label: `call tool on ${server.name}`,
			description:
				`Call a tool on the "${server.name}" MCP server. ` +
				`Use ${listToolName} first to discover available tool names and argument schemas.`,
			parameters: {
				type: "object",
				properties: {
					tool: { type: "string", description: `Tool name on "${server.name}".` },
					arguments: { type: "object", description: "JSON arguments for the tool.", additionalProperties: true },
				},
				required: ["tool", "arguments"],
				additionalProperties: false,
			},
			execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
				const { tool, arguments: args } = params as { tool: string; arguments: Record<string, unknown> };
				return executeMcpCode(
					provisioner,
					(interpreter) => acpMcpCallToolCode(server.name, tool, args ?? {}, interpreter),
					signal,
				);
			},
		});
	}
	return definitions;
}
