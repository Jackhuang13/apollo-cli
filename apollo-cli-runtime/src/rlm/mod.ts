import * as fs from "node:fs";
import * as path from "node:path";

import { BashHandle, type BashOptions, BashResult, bash } from "./bash.ts";
import {
	get_harness_state,
	getHarnessState,
	HarnessEntry,
	type HarnessScope,
	HarnessState,
	harness,
	RefinementEvent,
} from "./harness.ts";
import { mcp } from "./mcp.ts";
import { _registerMcpHostRequest, McpIntegration, McpToolError, NotEnabled } from "./mcp_base.ts";
import { emit, is_active, isActive, op, startReplLoop } from "./repl.ts";

// The MCP bridge gets the unwrapped host result, not the raw reply envelope.
_registerMcpHostRequest((requestType, payload) => op(requestType, payload));

/** High-level host request: `(requestType, payload?)` → unwrapped result record. */
export const host_request = op;
export const hostRequest = op;

export const _NOT_CALLABLE_MESSAGE =
	"`rlm` is a namespace module, not a callable function. " +
	"To spawn a child agent, use `await rlm.spawn(...)` or `await rlm.create_session(...)`.\n\n" +
	"Available on `rlm`:\n" +
	"  await rlm.spawn({ prompt, ... })             — launch a tracked subagent\n" +
	"  await rlm.create_session({ name, ... })      — create a named subagent session\n" +
	"  await rlm.find_models(query)                 — search available models\n" +
	"  await rlm.list_subagents()                   — list active/finished subagents\n" +
	"  await rlm.collect(handles, options)          — collect results from subagents\n" +
	"  await rlm.progress_note(text)                — emit an orchestration progress note\n" +
	"  await rlm.delete_subagent(id)                — delete a subagent\n" +
	"  rlm.view(path, { start, end })               — read file with line numbers\n" +
	"  await bash(command, { timeout, bg })         — run shell commands\n" +
	"  await mcp.list_tools() / mcp.call_tool(...)  — interact with MCP servers\n" +
	"  harness                                      — inspect/evolve harness rules & skills";

export const _RENAMED_RUN_MESSAGE =
	"`rlm.run` has been renamed to `rlm.spawn`. " +
	"Use `await rlm.spawn({ prompt: '...', name: '...', model: '...' })` or `await rlm.create_session(...)`.";

export interface ViewOptions {
	start?: number;
	end?: number;
	max_lines?: number;
	maxLines?: number;
}

/** Convenience helper: read a file's content as a UTF-8 string. */
export function read(filePath: string, encoding: BufferEncoding = "utf8"): string {
	const resolved = path.resolve(process.cwd(), filePath);
	return fs.readFileSync(resolved, encoding);
}

/** Convenience helper: write data to a file (creates parent dirs if needed). */
export function write(filePath: string, data: string | NodeJS.ArrayBufferView): void {
	const resolved = path.resolve(process.cwd(), filePath);
	fs.mkdirSync(path.dirname(resolved), { recursive: true });
	fs.writeFileSync(resolved, data);
}

export function view(
	filePath: string,
	options: ViewOptions | number = {},
	maybeEnd?: number,
): string {
	let start = 1;
	let end: number | undefined;
	let maxLines = 800;

	if (typeof options === "number") {
		start = Math.max(1, options);
		if (typeof maybeEnd === "number") {
			end = maybeEnd;
		}
	} else if (options && typeof options === "object") {
		if (typeof options.start === "number") start = Math.max(1, options.start);
		if (typeof options.end === "number") end = options.end;
		if (typeof options.max_lines === "number") maxLines = options.max_lines;
		else if (typeof options.maxLines === "number") maxLines = options.maxLines;
	}

	const resolved = path.resolve(process.cwd(), filePath);
	if (!fs.existsSync(resolved)) {
		throw new Error(`File not found: ${filePath}`);
	}
	const stat = fs.statSync(resolved);
	if (stat.isDirectory()) {
		const entries = fs.readdirSync(resolved, { withFileTypes: true });
		return entries
			.map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
			.sort()
			.join("\n");
	}

	const content = fs.readFileSync(resolved, "utf8");
	const lines = content.split(/\r?\n/);
	const totalLines = lines.length;
	const startIdx = Math.max(0, start - 1);
	const effectiveEnd = end !== undefined ? Math.min(totalLines, end) : Math.min(totalLines, startIdx + maxLines);
	const slice = lines.slice(startIdx, effectiveEnd);
	const width = String(effectiveEnd).length;

	const numbered = slice.map((line, i) => {
		const lineNo = String(startIdx + i + 1).padStart(width, " ");
		return `${lineNo}|${line}`;
	});

	if (effectiveEnd < totalLines) {
		numbered.push(`... (${totalLines - effectiveEnd} more lines, total ${totalLines})`);
	}
	return numbered.join("\n");
}

export interface SpawnOptions {
	prompt?: string;
	task?: string;
	name?: string;
	role?: string;
	model?: string;
	thinking_level?: string;
	thinkingLevel?: string;
	cwd?: string;
	worktree?: boolean;
	background?: boolean;
	bg?: boolean;
	system_prompt?: string;
	systemPrompt?: string;
	skills?: string[];
	timeout?: number;
	[key: string]: unknown;
}

/** Spawn options the host rejects; passing any of them is a client-side error. */
const UNSUPPORTED_SPAWN_KEYS = [
	"cwd",
	"worktree",
	"background",
	"bg",
	"system_prompt",
	"systemPrompt",
	"skills",
	"timeout",
] as const;

function _spawnKwargs(opts: SpawnOptions, { requiredName = false, allowCwd = false } = {}): Record<string, unknown> {
	const name = opts.name ?? opts.role;
	if (requiredName && (typeof name !== "string" || !name)) {
		throw new Error("rlm.spawn requires a name (or role) that is unique among siblings");
	}
	const unsupported = UNSUPPORTED_SPAWN_KEYS.filter(
		(key) => (allowCwd ? key !== "cwd" : true) && opts[key] !== undefined,
	);
	if (unsupported.length > 0) {
		throw new Error(
			`Only name, model, and thinking are passed to the host; remove unsupported options: ${unsupported
				.sort()
				.join(", ")}`,
		);
	}
	const kwargs: Record<string, unknown> = {};
	if (name !== undefined) kwargs.name = name;
	if (opts.model !== undefined) kwargs.model = opts.model;
	const thinking = opts.thinking_level ?? opts.thinkingLevel;
	if (thinking !== undefined) kwargs.thinking = thinking;
	if (allowCwd && opts.cwd !== undefined) kwargs.cwd = opts.cwd;
	return kwargs;
}

export async function spawn(
	promptOrOptions: string | SpawnOptions,
	extraOptionsOrName?: SpawnOptions | string,
): Promise<Record<string, unknown>> {
	let opts: SpawnOptions;
	if (typeof promptOrOptions === "string") {
		if (typeof extraOptionsOrName === "string") {
			opts = { prompt: promptOrOptions, name: extraOptionsOrName };
		} else {
			opts = { prompt: promptOrOptions, ...(extraOptionsOrName ?? {}) };
		}
	} else {
		opts = { ...promptOrOptions };
	}
	const prompt = opts.prompt ?? opts.task;
	if (typeof prompt !== "string" || !prompt.trim()) {
		throw new Error("rlm.spawn requires a non-empty prompt");
	}
	return await op("rlm.run", { prompt, kwargs: _spawnKwargs(opts, { requiredName: true }) });
}

export async function create_session(
	promptOrOptions: string | SpawnOptions = {},
	extraOptionsOrName?: SpawnOptions | string,
): Promise<Record<string, unknown>> {
	let opts: SpawnOptions;
	if (typeof promptOrOptions === "string") {
		if (typeof extraOptionsOrName === "string") {
			opts = { prompt: promptOrOptions, name: extraOptionsOrName };
		} else {
			opts = { prompt: promptOrOptions, ...(extraOptionsOrName ?? {}) };
		}
	} else {
		opts = { ...promptOrOptions };
	}
	const prompt = opts.prompt ?? opts.task;
	if (typeof prompt !== "string" || !prompt.trim()) {
		throw new Error("rlm.create_session requires a non-empty prompt");
	}
	return await op("rlm.create_session", { prompt, kwargs: _spawnKwargs(opts, { allowCwd: true }) });
}

export const createSession = create_session;

export async function find_models(query = "", limit?: number): Promise<unknown[]> {
	const payload: Record<string, unknown> = { query };
	if (limit !== undefined) payload.limit = limit;
	const result = await op("rlm.find_models", payload);
	return (result.models as unknown[]) ?? [];
}

export const findModels = find_models;

export async function list_subagents(): Promise<unknown[]> {
	const result = await op("rlm.list_subagents", {});
	return (result.subagents as unknown[]) ?? [];
}

export const listSubagents = list_subagents;

export async function collect(
	targets?: unknown,
	optionsOrTimeout?: Record<string, unknown> | number,
): Promise<Record<string, unknown>> {
	const payload: Record<string, unknown> = { targets };
	if (typeof optionsOrTimeout === "number") {
		payload.timeout_ms = optionsOrTimeout;
	} else if (optionsOrTimeout && typeof optionsOrTimeout === "object") {
		const timeoutMs = optionsOrTimeout.timeout_ms ?? optionsOrTimeout.timeoutMs;
		if (timeoutMs !== undefined) payload.timeout_ms = timeoutMs;
	}
	return await op("rlm.collect", payload);
}

/** Hard bound for one progress note; the session handler owns the time throttle. */
const RLM_PROGRESS_NOTE_MAX_LENGTH = 512;

export interface ProgressNoteResult {
	accepted: boolean;
	/** Milliseconds until the next note can be accepted; absent when accepted. */
	retry_after_ms?: number;
}

/**
 * Report brief in-flight progress to the parent orchestrator. The note (at most
 * 512 characters, about one per 10 seconds) reaches the parent's child snapshots
 * and roster entries without steering the parent or requiring an explicit reply.
 * A throttled note returns `accepted: false` with a `retry_after_ms` hint.
 */
export async function progress_note(message: string): Promise<ProgressNoteResult> {
	if (typeof message !== "string") {
		throw new TypeError(`message must be a string, got ${typeof message}`);
	}
	const stripped = message.trim();
	if (!stripped) {
		throw new Error("message must not be empty");
	}
	if (stripped.length > RLM_PROGRESS_NOTE_MAX_LENGTH) {
		throw new Error(`message must be at most ${RLM_PROGRESS_NOTE_MAX_LENGTH} characters`);
	}
	return (await op("rlm.progress.note", { message: stripped })) as ProgressNoteResult;
}

export const progressNote = progress_note;

export async function delete_subagent(target: string): Promise<Record<string, unknown>> {
	return await op("rlm.delete_subagent", { target });
}

export const deleteSubagent = delete_subagent;

const _rlmNamespaceTarget = Object.assign(
	function _rlmNotCallable(): never {
		throw new TypeError(_NOT_CALLABLE_MESSAGE);
	},
	{
		bash,
		BashHandle,
		BashResult,
		mcp,
		harness,
		get_harness_state,
		getHarnessState,
		HarnessEntry,
		HarnessState,
		RefinementEvent,
		McpIntegration,
		McpToolError,
		NotEnabled,
		host_request,
		hostRequest,
		emit,
		is_active,
		isActive,
		read,
		write,
		view,
		spawn,
		create_session,
		createSession,
		find_models,
		findModels,
		list_subagents,
		listSubagents,
		collect,
		progress_note,
		progressNote,
		delete_subagent,
		deleteSubagent,
	},
);

export const rlm = new Proxy(_rlmNamespaceTarget, {
	apply(): never {
		throw new TypeError(_NOT_CALLABLE_MESSAGE);
	},
	get(target, prop, receiver) {
		if (prop === "run") {
			throw new Error(_RENAMED_RUN_MESSAGE);
		}
		return Reflect.get(target, prop, receiver);
	},
}) as unknown as typeof _rlmNamespaceTarget;

export {
	BashHandle,
	type BashOptions,
	BashResult,
	bash,
	emit,
	get_harness_state,
	getHarnessState,
	HarnessEntry,
	type HarnessScope,
	HarnessState,
	harness,
	is_active,
	isActive,
	McpIntegration,
	McpToolError,
	mcp,
	NotEnabled,
	RefinementEvent,
	startReplLoop,
};

// If executed directly as the kernel entrypoint (`deno run ... mod.ts` or `tsx mod.ts`), start the REPL loop
const isMainEntry = (() => {
	const argv1 = process.argv[1];
	if (!argv1) return false;
	const base = path.basename(argv1);
	return (
		(base === "mod.ts" || base === "mod.js" || base === "repl.ts" || base === "repl.js" || base === "index.ts") &&
		!process.env.APOLLO_RLM_LIBRARY_ONLY
	);
})();

if (isMainEntry) {
	void startReplLoop({
		rlm,
		bash,
		BashHandle,
		BashResult,
		mcp,
		harness,
		get_harness_state,
		getHarnessState,
		HarnessEntry,
		HarnessState,
		RefinementEvent,
		McpIntegration,
		McpToolError,
		NotEnabled,
		host_request,
		hostRequest,
		emit,
		read,
		write,
		view,
		spawn,
		create_session,
		createSession,
		find_models,
		findModels,
		list_subagents,
		listSubagents,
		collect,
		progress_note,
		progressNote,
		delete_subagent,
		deleteSubagent,
	});
}
