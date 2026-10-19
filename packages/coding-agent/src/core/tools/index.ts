export { acpMcpToolNames, createAcpMcpToolDefinitions } from "./acp-mcp.js";
export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.js";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.js";
export { withFileMutationQueue } from "./file-mutation-queue.js";
export {
	createIpythonTool,
	createIpythonToolDefinition,
	createIScriptTool,
	createIScriptToolDefinition,
	IpythonKernelProvisioner,
	type IpythonToolDetails,
	type IpythonToolInput,
	type IpythonToolOptions,
	IScriptKernelProvisioner,
	type IScriptToolDetails,
	type IScriptToolInput,
	type IScriptToolOptions,
} from "./iscript.js";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.js";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "../extensions/types.js";
import { createIScriptToolDefinition, type IScriptToolOptions } from "./iscript.js";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName = "iscript" | "ipython";

export interface ToolsOptions {
	iscript?: IScriptToolOptions;
	ipython?: IScriptToolOptions;
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<string, ToolDef> {
	const iscriptOptions = options?.iscript ?? options?.ipython;
	const iscriptDef = createIScriptToolDefinition(cwd, { ...iscriptOptions, name: "iscript" });
	const ipythonDef = createIScriptToolDefinition(cwd, {
		...iscriptOptions,
		name: "ipython",
		provisioner: iscriptDef ? iscriptOptions?.provisioner : undefined,
	});
	return {
		iscript: iscriptDef,
		ipython: ipythonDef,
	};
}
