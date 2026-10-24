import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as moduleBuiltin from "node:module";
import * as path from "node:path";
import * as readline from "node:readline";
import * as util from "node:util";
import * as v8 from "node:v8";
import * as vm from "node:vm";

import { _kill_live_handles, _registerReplBridge } from "./bash.ts";
import { parseSync } from "./vendor/parser.js";

export const PROTOCOL_VERSION = 3;
export const DEFAULT_SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024;
export const DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES = 16 * 1024 * 1024;
export const SNAPSHOT_MAGIC = Buffer.from("APOLLO-CLI-KERNEL-SNAPSHOT-V1\n", "utf8");
const LEGACY_SNAPSHOT_MAGIC = Buffer.from("PRIME-AGENT-KERNEL-SNAPSHOT-V2\n", "utf8");

interface ActiveCellContext {
	id: string | null;
	execution: CellExecution | null;
}

const _cellStorage = new AsyncLocalStorage<ActiveCellContext>();
let _fallbackCellId: string | null = null;
let _fallbackExecution: CellExecution | null = null;

function _getActiveCellId(): string | null {
	const store = _cellStorage.getStore();
	if (store && store.id !== null) {
		return store.id;
	}
	return _fallbackCellId;
}

function _getActiveExecution(): CellExecution | null {
	const store = _cellStorage.getStore();
	if (store && store.execution !== null) {
		return store.execution;
	}
	return _fallbackExecution;
}

export function is_active(): boolean {
	return _getActiveCellId() !== null;
}

export const isActive = is_active;

let _protoWrite: (line: string) => void = (line: string) => {
	fs.writeSync(1, `${line}\n`);
};

export function _setProtoWriter(writer: (line: string) => void): void {
	_protoWrite = writer;
}

function _sendProto(payload: Record<string, unknown>): void {
	const line = JSON.stringify(payload);
	_protoWrite(line);
}

function _sendStream(name: "stdout" | "stderr", text: string, cellId?: string | null): void {
	if (!text) return;
	const id = cellId !== undefined ? cellId : _getActiveCellId();
	if (id === null) return;
	_sendProto({
		id,
		event: name,
		text,
	});
}

export function emit(data: Record<string, unknown>, metadata: Record<string, unknown> = {}): void {
	const id = _getActiveCellId();
	if (id === null) {
		throw new Error("emit() called outside an active cell execution");
	}
	_sendProto({
		id,
		event: "display",
		data,
		metadata,
	});
}

interface PendingHostRequest {
	resolve: (reply: Record<string, unknown>) => void;
	reject: (err: Error) => void;
	timer?: ReturnType<typeof setTimeout>;
}

const _pendingRequests = new Map<string, PendingHostRequest>();

function _isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function host_request(
	payload: Record<string, unknown>,
	timeout = 300.0,
): Promise<Record<string, unknown>> {
	const requestId = randomUUID().replaceAll("-", "");
	return new Promise<Record<string, unknown>>((resolve, reject) => {
		const entry: PendingHostRequest = { resolve, reject };
		if (timeout > 0 && Number.isFinite(timeout)) {
			entry.timer = setTimeout(() => {
				_pendingRequests.delete(requestId);
				reject(new Error(`Host request timed out after ${timeout}s`));
			}, timeout * 1000);
		}
		_pendingRequests.set(requestId, entry);
		_sendProto({
			id: requestId,
			event: "host_request",
			data: payload,
		});
	});
}

export const hostRequest = host_request;

/** Reject every pending host request; a closed host can never answer again. */
export function _failPendingHostRequests(): void {
	for (const [requestId, entry] of [..._pendingRequests]) {
		_pendingRequests.delete(requestId);
		if (entry.timer) clearTimeout(entry.timer);
		entry.reject(new Error("host connection closed; host_request cannot be answered"));
	}
}

let _hostReplyResolver: ((type: string, payload: Record<string, unknown> | null | undefined) => Promise<Record<string, unknown>>) | null = null;

export function _setHostReplyResolver(resolver: ((type: string, payload: Record<string, unknown> | null | undefined) => Promise<Record<string, unknown>>) | null): void {
	_hostReplyResolver = resolver;
}

/**
 * High-level typed host request: sends `{...payload, type: requestType}` and
 * unwraps the reply envelope. `requestType` is written last so a payload
 * `type` key cannot reroute the request. Mirrors the Python runtime's
 * `rlm.host_request(request_type, payload)`.
 */
export async function op(
	requestType: string,
	payload: Record<string, unknown> | null | undefined = undefined,
	timeout = 300.0,
): Promise<Record<string, unknown>> {
	if (_hostReplyResolver) {
		return await _hostReplyResolver(requestType, payload);
	}
	const reply = await host_request({ ...(payload ?? {}), type: requestType }, timeout);
	const status = reply.status;
	if (status === "ok") {
		return _isPlainRecord(reply.result) ? reply.result : {};
	}
	if (status === "error") {
		throw new Error(String(reply.error ?? `host request ${requestType} failed`));
	}
	throw new Error(`host request ${requestType} returned unexpected status: ${String(status)}`);
}

export class CellExecution {
	readonly cellId: string;
	readonly completionBarrier: Promise<void>;
	private _resolveBarrier!: () => void;
	private _pendingCount = 0;
	private _waiters: Array<() => void> = [];
	private _abortListeners = new Set<() => void>();
	private _interrupted = false;

	constructor(cellId: string) {
		this.cellId = cellId;
		this.completionBarrier = new Promise<void>((resolve) => {
			this._resolveBarrier = resolve;
		});
	}

	markCompleted(): void {
		this._resolveBarrier();
	}

	get interrupted(): boolean {
		return this._interrupted;
	}

	retain(): void {
		this._pendingCount += 1;
	}

	release(): void {
		this._pendingCount = Math.max(0, this._pendingCount - 1);
		if (this._pendingCount === 0) {
			const waiters = this._waiters.splice(0, this._waiters.length);
			for (const w of waiters) {
				w();
			}
		}
	}

	onAbort(listener: () => void): () => void {
		if (this._interrupted) {
			try {
				listener();
			} catch {
				// Ignore listener errors
			}
			return () => {};
		}
		this._abortListeners.add(listener);
		return () => {
			this._abortListeners.delete(listener);
		};
	}

	interrupt(): void {
		this._interrupted = true;
		for (const listener of [...this._abortListeners]) {
			try {
				listener();
			} catch {
				// Ignore listener errors
			}
		}
		this._abortListeners.clear();
		const waiters = this._waiters.splice(0, this._waiters.length);
		for (const w of waiters) {
			w();
		}
	}

	waitForBackgroundTasks(timeoutMs = 50): Promise<void> {
		if (this._pendingCount === 0 || this._interrupted) {
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				resolve();
			}, timeoutMs);
			this._waiters.push(() => {
				clearTimeout(timer);
				resolve();
			});
		});
	}
}

// Track user-defined global variable names across cells
const _userGlobals = new Set<string>();
const _builtinGlobals = new Set<string>(Object.getOwnPropertyNames(globalThis));

const _RESERVED_NAMES = new Set<string>([
	"globalThis",
	"global",
	"process",
	"Buffer",
	"console",
	"require",
	"setTimeout",
	"clearTimeout",
	"setInterval",
	"clearInterval",
	"setImmediate",
	"clearImmediate",
	"queueMicrotask",
	"structuredClone",
	"atob",
	"btoa",
	"fetch",
	"Request",
	"Response",
	"Headers",
	"URL",
	"URLSearchParams",
	"TextEncoder",
	"TextDecoder",
	"AbortController",
	"AbortSignal",
	"Event",
	"EventTarget",
	"MessageChannel",
	"MessagePort",
	"MessageEvent",
	" BroadcastChannel",
	"crypto",
	"performance",
	"Deno",
	"rlm",
	"bash",
	"BashHandle",
	"BashResult",
	"mcp",
	"harness",
	"get_harness_state",
	"getHarnessState",
	"HarnessEntry",
	"HarnessState",
	"RefinementEvent",
	"McpIntegration",
	"McpToolError",
	"NotEnabled",
	"host_request",
	"hostRequest",
	"emit",
	"view",
	"spawn",
	"create_session",
	"createSession",
	"find_models",
	"findModels",
	"list_subagents",
	"listSubagents",
	"collect",
	"progress_note",
	"progressNote",
	"delete_subagent",
	"deleteSubagent",
	"read",
	"write",
	"__apollo_require__",
	"__apollo_import__",
]);

export function recordUserGlobal(name: string): void {
	if (!_RESERVED_NAMES.has(name) && !name.startsWith("__apollo_")) {
		_userGlobals.add(name);
	}
}

function _stripTypeScript(code: string): string {
	if (typeof moduleBuiltin.stripTypeScriptTypes === "function") {
		try {
			return moduleBuiltin.stripTypeScriptTypes(code, { mode: "strip" });
		} catch {
			// Fall back to raw code if strip fails on partial snippet
		}
	}
	return code;
}

interface TopLevelStatement {
	text: string;
	start: number;
	end: number;
}

/**
 * Split JavaScript code into top-level statements while respecting strings,
 * template literals, comments, regex literals, and nested brackets/braces/parens.
 */
function _splitTopLevelStatements(code: string): TopLevelStatement[] {
	let parsed: any;
	try {
		parsed = parseSync(code, { sourceFilename: "cell.ts" });
	} catch {
		parsed = null;
	}

	if (parsed && parsed.errors?.length === 0 && Array.isArray(parsed.program?.body) && parsed.program.body.length > 0) {
		const stmts = parsed.program.body;
		return stmts.map((s: any) => ({
			text: code.slice(s.start, s.end),
			start: s.start,
			end: s.end,
		}));
	}

	// Incremental parser fallback for cell ASI boundaries (e.g. statement followed by `/regex/`)
	const lines = code.split("\n");
	const statements: TopLevelStatement[] = [];
	let buffer = "";
	let bufStart = 0;
	let currentOffset = 0;

	for (let idx = 0; idx < lines.length; idx++) {
		const line = lines[idx]!;
		const candidate = buffer ? `${buffer}\n${line}` : line;
		let valid = false;
		try {
			const p = parseSync(candidate, { sourceFilename: "chunk.ts" });
			if (p.errors.length === 0) valid = true;
		} catch {
			valid = false;
		}

		if (valid && candidate.trim().length > 0) {
			const nextLine = lines[idx + 1];
			const isContinuation =
				nextLine !== undefined &&
				(/^(?:\.|\`|\?|,|[+\-*%&|^=<>]|\bin\b|\binstanceof\b)/.test(nextLine.trim()) ||
					/^\/\s/.test(nextLine.trim()));
			if (!isContinuation) {
				statements.push({
					text: candidate,
					start: bufStart,
					end: currentOffset + line.length,
				});
				buffer = "";
				bufStart = currentOffset + line.length + 1;
				currentOffset += line.length + 1;
				continue;
			}
		}
		buffer = candidate;
		currentOffset += line.length + 1;
	}
	if (buffer.trim().length > 0) {
		statements.push({ text: buffer, start: bufStart, end: code.length });
	}
	return statements;
}

function _extractDeclaredNames(pattern: string): string[] {
	const names: string[] = [];
	// Remove default value expressions at top level of pattern
	let depth = 0;
	let cleaned = "";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i]!;
		if (ch === "(" || ch === "[" || ch === "{") {
			depth++;
			cleaned += ch;
		} else if (ch === ")" || ch === "]" || ch === "}") {
			depth = Math.max(0, depth - 1);
			cleaned += ch;
		} else if (ch === "=" && depth <= 1) {
			// Skip until comma or closing bracket at depth
			let skipDepth = depth;
			i++;
			while (i < pattern.length) {
				const c = pattern[i]!;
				if (c === "(" || c === "[" || c === "{") skipDepth++;
				else if (c === ")" || c === "]" || c === "}") {
					if (skipDepth === depth) {
						i--;
						break;
					}
					skipDepth--;
				} else if (c === "," && skipDepth === depth) {
					i--;
					break;
				}
				i++;
			}
		} else {
			cleaned += ch;
		}
	}

	// Replace property keys in object destructuring `{ key: target }` -> `{ target }`
	const withoutKeys = cleaned.replace(/([A-Za-z_$][\w$]*)\s*:/g, "");
	const matches = withoutKeys.matchAll(/[A-Za-z_$][\w$]*/g);
	for (const m of matches) {
		const id = m[0];
		if (id && id !== "const" && id !== "let" && id !== "var") {
			names.push(id);
		}
	}
	return names;
}

function _preprocessBangLines(code: string): string {
	// Transform top-level lines starting with `!cmd` into `await bash("cmd")` + stream output
	const lines = code.split("\n");
	const out: string[] = [];
	for (const line of lines) {
		const trimmed = line.trimStart();
		if (trimmed.startsWith("!") && !trimmed.startsWith("!=") && !trimmed.startsWith("!!")) {
			const cmd = trimmed.slice(1).trim();
			if (cmd.length > 0) {
				out.push(
					`{ const __bang_res = await globalThis.bash(${JSON.stringify(cmd)}); if (__bang_res.output) { process.stdout.write(__bang_res.output); } globalThis._ = __bang_res; }`,
				);
				continue;
			}
		}
		out.push(line);
	}
	return out.join("\n");
}

interface OxcSyntaxErrorInfo {
	message: string;
	start?: number;
	end?: number;
	severity?: string;
}

class ReplSyntaxError extends SyntaxError {
	readonly oxcError?: OxcSyntaxErrorInfo;
	readonly sourceCode?: string;

	constructor(message: string, oxcError?: OxcSyntaxErrorInfo, sourceCode?: string) {
		super(message);
		this.name = "SyntaxError";
		this.oxcError = oxcError;
		this.sourceCode = sourceCode;
	}
}

function _checkIncrementalSyntaxErrors(code: string): { message: string; offset: number } | null {
	const lines = code.split("\n");
	let buffer = "";
	let bufStart = 0;
	let currentOffset = 0;

	for (let idx = 0; idx < lines.length; idx++) {
		const line = lines[idx]!;
		const candidate = buffer ? `${buffer}\n${line}` : line;
		let valid = false;
		try {
			const p = parseSync(candidate, { sourceFilename: "chunk.ts" });
			if (p.errors.length === 0) valid = true;
		} catch {
			valid = false;
		}

		if (valid && candidate.trim().length > 0) {
			const nextLine = lines[idx + 1];
			const isContinuation =
				nextLine !== undefined &&
				(/^(?:\.|\`|\?|,|[+\-*%&|^=<>]|\bin\b|\binstanceof\b)/.test(nextLine.trim()) ||
					/^\/\s/.test(nextLine.trim()));
			if (!isContinuation) {
				buffer = "";
				bufStart = currentOffset + line.length + 1;
				currentOffset += line.length + 1;
				continue;
			}
		}
		buffer = candidate;
		currentOffset += line.length + 1;
	}

	if (buffer.trim().length > 0) {
		let p: any;
		try {
			p = parseSync(buffer, { sourceFilename: "leftover.ts" });
		} catch {
			p = null;
		}
		const err = p?.errors?.[0];
		const message = err?.message || "Syntax error during cell parsing";
		const offset = bufStart + (typeof err?.start === "number" ? err.start : 0);
		return { message, offset };
	}

	return null;
}

function _transformTopLevelImports(code: string): string {
	let parsed: any;
	try {
		parsed = parseSync(code, { sourceFilename: "cell.ts" });
	} catch {
		parsed = null;
	}

	if (!parsed || parsed.errors?.length > 0 || !parsed.program) {
		const syntaxErr = _checkIncrementalSyntaxErrors(code);
		if (syntaxErr) {
			throw new ReplSyntaxError(syntaxErr.message, { start: syntaxErr.offset, message: syntaxErr.message }, code);
		}
		return code;
	}

	const replacements: Array<{
		start: number;
		end: number;
		type: "dynamic" | "static";
		node: any;
	}> = [];

	// 1. Dynamic import expressions
	function findDynamic(node: any): void {
		if (!node || typeof node !== "object") return;
		if (node.type === "ImportExpression") {
			replacements.push({
				start: node.start,
				end: node.end,
				type: "dynamic",
				node,
			});
		}
		for (const key of Object.keys(node)) {
			const val = node[key];
			if (Array.isArray(val)) {
				for (const item of val) findDynamic(item);
			} else if (val && typeof val === "object") {
				findDynamic(val);
			}
		}
	}

	findDynamic(parsed.program);

	// 2. Static import declarations
	for (const stmt of parsed.program.body) {
		if (stmt.type === "ImportDeclaration") {
			replacements.push({
				start: stmt.start,
				end: stmt.end,
				type: "static",
				node: stmt,
			});
		}
	}

	replacements.sort((a, b) => b.start - a.start);

	let out = code;
	for (const rep of replacements) {
		if (rep.type === "dynamic") {
			const imp = rep.node;
			const argText = code.slice(imp.source.start, imp.source.end);
			const tail = code.slice(imp.end);
			const chain = /^\s*[.(]/.test(tail);
			const head = code.slice(0, imp.start);
			const awaited = /\bawait\s*$/.test(head);

			const base = `globalThis.__apollo_import__(${argText})`;
			let replacementStr = base;
			if (chain) {
				replacementStr = awaited ? `(await ${base})` : `(${base})`;
			}
			out = out.slice(0, imp.start) + replacementStr + out.slice(imp.end);
		} else if (rep.type === "static") {
			const decl = rep.node;
			const specifier = JSON.stringify(decl.source.value);
			const specifiers = decl.specifiers || [];

			let replacementStr = "";
			if (specifiers.length === 0) {
				replacementStr = `await globalThis.__apollo_import__(${specifier});`;
			} else {
				const defaultSpec = specifiers.find((s: any) => s.type === "ImportDefaultSpecifier");
				const nsSpec = specifiers.find((s: any) => s.type === "ImportNamespaceSpecifier");
				const namedSpecs = specifiers.filter((s: any) => s.type === "ImportSpecifier");

				if (nsSpec) {
					const nsName = nsSpec.local.name;
					recordUserGlobal(nsName);
					replacementStr = `const ${nsName} = (globalThis.${nsName} = await globalThis.__apollo_import__(${specifier}));`;
				} else if (defaultSpec && namedSpecs.length === 0) {
					const defName = defaultSpec.local.name;
					recordUserGlobal(defName);
					replacementStr = `const __mod_${defName} = await globalThis.__apollo_import__(${specifier}); const ${defName} = (globalThis.${defName} = __mod_${defName}.default ?? __mod_${defName});`;
				} else if (!defaultSpec && namedSpecs.length > 0) {
					const inner = namedSpecs
						.map((s: any) => {
							recordUserGlobal(s.local.name);
							return s.imported.name === s.local.name ? s.local.name : `${s.imported.name}: ${s.local.name}`;
						})
						.join(", ");
					const assignGlobals = namedSpecs.map((s: any) => `globalThis.${s.local.name} = ${s.local.name};`).join(" ");
					replacementStr = `const { ${inner} } = await globalThis.__apollo_import__(${specifier}); ${assignGlobals}`;
				} else if (defaultSpec && namedSpecs.length > 0) {
					const defName = defaultSpec.local.name;
					recordUserGlobal(defName);
					const inner = namedSpecs
						.map((s: any) => {
							recordUserGlobal(s.local.name);
							return s.imported.name === s.local.name ? s.local.name : `${s.imported.name}: ${s.local.name}`;
						})
						.join(", ");
					const assignGlobals = [
						`globalThis.${defName} = ${defName};`,
						...namedSpecs.map((s: any) => `globalThis.${s.local.name} = ${s.local.name};`),
					].join(" ");
					replacementStr = `const __mod_${defName} = await globalThis.__apollo_import__(${specifier}); const ${defName} = __mod_${defName}.default ?? __mod_${defName}; const { ${inner} } = __mod_${defName}; ${assignGlobals}`;
				}
			}
			out = out.slice(0, decl.start) + replacementStr + out.slice(decl.end);
		}
	}

	return out;
}
function _isExpressionExecutable(expr: string): boolean {
	const trimmed = expr.trim().replace(/;+\s*$/, "");
	if (!trimmed) return false;
	if (
		/^(const|let|var|function|class|if|for|while|do|switch|try|return|throw|break|continue|import|export|interface|type)\b/.test(
			trimmed,
		)
	) {
		return false;
	}
	try {
		new vm.Script(`(async () => (\n${trimmed}\n))`, { filename: "<expr-check>" });
		return true;
	} catch {
		return false;
	}
}

function _collectDeclaredGlobalsFromStatement(stmt: string): string[] {
	const trimmed = stmt.trim();
	const names: string[] = [];

	const fnMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/);
	if (fnMatch?.[1]) {
		names.push(fnMatch[1]);
		return names;
	}

	const classMatch = trimmed.match(/^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/);
	if (classMatch?.[1]) {
		names.push(classMatch[1]);
		return names;
	}

	const varMatch = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([\s\S]+)$/);
	if (varMatch?.[1]) {
		const declBody = varMatch[1].replace(/;+\s*$/, "");
		// Split top-level declarators by comma, ignoring rhs after `=`
		let depth = 0;
		let inRhs = false;
		let pattern = "";
		for (let i = 0; i < declBody.length; i++) {
			const ch = declBody[i]!;
			if (ch === "'" || ch === '"' || ch === "`") {
				const q = ch;
				i++;
				while (i < declBody.length && declBody[i] !== q) {
					if (declBody[i] === "\\") i += 2;
					else i++;
				}
				continue;
			}
			if (ch === "(" || ch === "[" || ch === "{") {
				depth++;
				if (!inRhs) pattern += ch;
			} else if (ch === ")" || ch === "]" || ch === "}") {
				depth = Math.max(0, depth - 1);
				if (!inRhs) pattern += ch;
			} else if (ch === "=" && depth === 0 && !inRhs) {
				inRhs = true;
			} else if (ch === "," && depth === 0) {
				names.push(..._extractDeclaredNames(pattern));
				pattern = "";
				inRhs = false;
			} else if (!inRhs) {
				pattern += ch;
			}
		}
		if (pattern.trim().length > 0) {
			names.push(..._extractDeclaredNames(pattern));
		}
	}

	return names;
}

function _buildCellWrapper(rawCode: string): { wrappedCode: string; declaredNames: string[] } {
	const bangExpanded = _preprocessBangLines(rawCode);
	const tsStripped = _stripTypeScript(bangExpanded);
	const importTransformed = _transformTopLevelImports(tsStripped);
	const statements = _splitTopLevelStatements(importTransformed);

	const declaredNames: string[] = [];
	const bodyParts: string[] = [];

	for (let idx = 0; idx < statements.length; idx++) {
		const stmt = statements[idx]!;
		const isLast = idx === statements.length - 1;
		const names = _collectDeclaredGlobalsFromStatement(stmt.text);
		for (const n of names) {
			declaredNames.push(n);
			recordUserGlobal(n);
		}

		// Strip leading `export ` if present
		const cleanText = stmt.text.replace(/^\s*export\s+/, "");

		if (isLast && names.length === 0 && _isExpressionExecutable(cleanText)) {
			const exprText = cleanText.trim().replace(/;+\s*$/, "");
			bodyParts.push(`return (\n${exprText}\n);`);
		} else {
			bodyParts.push(cleanText);
			if (names.length > 0) {
				const syncAssigns = names.map((n) => `globalThis.${n} = ${n};`).join(" ");
				bodyParts.push(syncAssigns);
			}
		}
	}

	const wrappedCode = `(async () => {\n${bodyParts.join("\n")}\n})()`;
	return { wrappedCode, declaredNames };
}

function _formatValue(val: unknown): string {
	return util.inspect(val, {
		depth: 4,
		colors: false,
		maxArrayLength: 100,
		breakLength: 80,
	});
}

/**
 * Guidance appended to failures models keep reproducing: Deno.* calls in the
 * Node kernel, and treating a completed bash result's `output` string as a
 * method.
 */
function _knownFailureHint(err: unknown): string | undefined {
	if (!(err instanceof Error)) return undefined;
	if (err.name === "ReferenceError" && /Deno is not defined/.test(err.message)) {
		return "Hint: this IScript kernel runs on Node (node:vm); use node:fs, node:path, node:child_process, and other node:* modules.";
	}
	if (err.name === "TypeError" && /\.output is not a function/.test(err.message)) {
		return "Hint: an awaited bash() result's output is a string property (result.output); the output() method exists only on a running handle, before awaiting.";
	}
	return undefined;
}

function _formatTraceback(err: unknown, cellNum: number): { ename: string; evalue: string; traceback: string[] } {
	const cellTag = `<cell-${cellNum}>`;
	const hint = _knownFailureHint(err);

	if (err instanceof ReplSyntaxError) {
		const ename = "SyntaxError";
		const evalue = err.message;
		const code = err.sourceCode ?? "";
		const rawOffset = typeof err.oxcError?.start === "number" ? err.oxcError.start : 0;
		const effectiveOffset = Math.min(rawOffset, code.length);

		let line = 1;
		let col = 1;
		for (let i = 0; i < effectiveOffset; i++) {
			if (code[i] === "\n") {
				line++;
				col = 1;
			} else {
				col++;
			}
		}

		const allLines = code.split("\n");
		let targetLineIdx = line - 1;
		let caretCol = col;
		if (
			targetLineIdx >= allLines.length ||
			(targetLineIdx > 0 && allLines[targetLineIdx] === "" && targetLineIdx === allLines.length - 1)
		) {
			targetLineIdx = Math.max(0, targetLineIdx - 1);
			line = targetLineIdx + 1;
			caretCol = allLines[targetLineIdx].length + 1;
			col = caretCol;
		}

		const sourceLine = allLines[targetLineIdx] ?? "";
		const caret = `${" ".repeat(Math.max(0, caretCol - 1))}^`;

		const traceback = [
			`SyntaxError: ${evalue}`,
			`    at ${cellTag}:${line}:${col}`,
			sourceLine,
			caret,
		];
		if (hint) traceback.push(hint);
		return { ename, evalue, traceback };
	}

	if (err instanceof Error) {
		const ename = err.name || "Error";
		const evalue = err.message || String(err);
		const rawStack = err.stack || `${ename}: ${evalue}`;
		const lines = rawStack
			.split("\n")
			.map((line) => line.replace(/<expr-check>|<check>|evalmachine\.<anonymous>/g, cellTag));
		if (!lines.some((l) => l.includes(cellTag))) {
			lines.push(`    at ${cellTag}:1:1`);
		}
		if (hint) lines.push(hint);
		return { ename, evalue, traceback: lines };
	}
	const text = String(err);
	const traceback = [`Error: ${text}`, `    at ${cellTag}:1:1`];
	if (hint) traceback.push(hint);
	return {
		ename: "Error",
		evalue: text,
		traceback,
	};
}

let _cellCounter = 0;

function _snapshotGlobalsBeforeCell(): Set<string> {
	return new Set<string>(Object.getOwnPropertyNames(globalThis));
}

function _detectNewGlobalsAfterCell(before: Set<string>): void {
	for (const key of Object.getOwnPropertyNames(globalThis)) {
		if (!before.has(key) && !_builtinGlobals.has(key)) {
			recordUserGlobal(key);
		}
	}
}

export async function executeCell(id: string, code: string, silent = false): Promise<void> {
	_cellCounter += 1;
	const cellNum = _cellCounter;
	const cellTag = `<cell-${cellNum}>`;
	const execution = new CellExecution(id);

	_fallbackCellId = id;
	_fallbackExecution = execution;

	const globalsBefore = _snapshotGlobalsBeforeCell();

	try {
		await _cellStorage.run({ id, execution }, async () => {
			if (!code.trim()) {
				_sendProto({ id, event: "done", status: "ok" });
				return;
			}

			let wrappedCode: string;
			try {
				const built = _buildCellWrapper(code);
				wrappedCode = built.wrappedCode;
			} catch (syntaxErr) {
				const formatted = _formatTraceback(syntaxErr, cellNum);
				_sendProto({
					id,
					event: "error",
					ename: formatted.ename,
					evalue: formatted.evalue,
					traceback: formatted.traceback,
				});
				_sendProto({ id, event: "done", status: "error" });
				return;
			}

			let script: vm.Script;
			try {
				script = new vm.Script(wrappedCode, { filename: cellTag });
			} catch (compileErr) {
				const formatted = _formatTraceback(compileErr, cellNum);
				_sendProto({
					id,
					event: "error",
					ename: formatted.ename,
					evalue: formatted.evalue,
					traceback: formatted.traceback,
				});
				_sendProto({ id, event: "done", status: "error" });
				return;
			}

			const abortPromise = new Promise<never>((_resolve, reject) => {
				execution.onAbort(() => {
					const err = new Error("Cell execution interrupted");
					err.name = "KeyboardInterrupt";
					reject(err);
				});
			});

			const runPromise = (async () => {
				const promise = script.runInThisContext({ breakOnSigint: false });
				return await promise;
			})();

			const value = await Promise.race([runPromise, abortPromise]);
			_detectNewGlobalsAfterCell(globalsBefore);

			await execution.waitForBackgroundTasks(50);

			let resultText: string | null = null;
			if (!silent && value !== undefined) {
				(globalThis as Record<string, unknown>)._ = value;
				recordUserGlobal("_");
				resultText = _formatValue(value);
			}

			if (resultText !== null) {
				_sendProto({
					id,
					event: "result",
					text: resultText,
				});
			}

			_sendProto({
				id,
				event: "done",
				status: "ok",
			});
		});
	} catch (err) {
		_detectNewGlobalsAfterCell(globalsBefore);
		await execution.waitForBackgroundTasks(25);
		const formatted = _formatTraceback(err, cellNum);
		_sendProto({
			id,
			event: "error",
			ename: formatted.ename,
			evalue: formatted.evalue,
			traceback: formatted.traceback,
		});
		_sendProto({
			id,
			event: "done",
			status: "error",
		});
	} finally {
		execution.markCompleted();
		if (_fallbackCellId === id) {
			_fallbackCellId = null;
			_fallbackExecution = null;
		}
	}
}

function _classifyType(val: unknown): string {
	if (val === null) return "null";
	if (Array.isArray(val)) return "Array";
	if (val instanceof Map) return "Map";
	if (val instanceof Set) return "Set";
	if (val instanceof Date) return "Date";
	if (val instanceof RegExp) return "RegExp";
	if (ArrayBuffer.isView(val)) return val.constructor.name;
	if (val instanceof ArrayBuffer) return "ArrayBuffer";
	if (typeof val === "object" && val.constructor && val.constructor.name) {
		return val.constructor.name;
	}
	return typeof val;
}

export interface SnapshotResult {
	path: string;
	manifest_path?: string;
	saved: string[];
	skipped: Array<{ name: string; type: string; reason: string; size_bytes?: number }>;
	pruned?: Array<{ name: string; type: string; size_bytes: number }>;
	total_bytes: number;
	max_bytes: number;
	max_variable_bytes: number;
}

export function handleSnapshot(msg: Record<string, unknown>): void {
	const id = String(msg.id ?? "");
	const targetPath = typeof msg.path === "string" ? msg.path : "";
	const manifestPath = typeof msg.manifest_path === "string" ? msg.manifest_path : undefined;
	const maxBytes = typeof msg.max_bytes === "number" && msg.max_bytes > 0 ? msg.max_bytes : DEFAULT_SNAPSHOT_MAX_BYTES;
	const maxVariableBytes =
		typeof msg.max_variable_bytes === "number" && msg.max_variable_bytes > 0
			? msg.max_variable_bytes
			: DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES;
	const pruneOversized = Boolean(msg.prune_oversized);

	if (!targetPath) {
		_sendProto({
			id,
			event: "snapshot_complete",
			status: "error",
			error: "snapshot requires a non-empty 'path'",
		});
		return;
	}

	try {
		const saved: string[] = [];
		const types: Record<string, string> = {};
		const skipped: Array<{ name: string; type: string; reason: string; size_bytes?: number }> = [];
		const pruned: Array<{ name: string; type: string; size_bytes: number }> = [];
		const frames: Array<{ name: string; type: string; frame: Buffer; payloadBytes: number }> = [];

		const g = globalThis as Record<string, unknown>;
		const candidateNames = [..._userGlobals].sort();

		for (const name of candidateNames) {
			if (_RESERVED_NAMES.has(name) || name.startsWith("__apollo_")) {
				continue;
			}
			if (!(name in g)) {
				continue;
			}
			const value = g[name];
			const typeName = _classifyType(value);

			if (typeof value === "function" || typeof value === "symbol") {
				skipped.push({ name, type: typeName, reason: "unserializable_type" });
				continue;
			}

			let serialized: Buffer;
			try {
				serialized = v8.serialize(value);
			} catch (err) {
				skipped.push({
					name,
					type: typeName,
					reason: err instanceof Error ? err.message : "serialize_failed",
				});
				continue;
			}

			if (serialized.byteLength > maxVariableBytes) {
				skipped.push({
					name,
					type: typeName,
					reason: "exceeds_max_variable_bytes",
					size_bytes: serialized.byteLength,
				});
				if (pruneOversized) {
					delete g[name];
					_userGlobals.delete(name);
					pruned.push({ name, type: typeName, size_bytes: serialized.byteLength });
				}
				continue;
			}

			const nameBuf = Buffer.from(name, "utf8");
			const headerBuf = Buffer.alloc(4 + nameBuf.byteLength + 8);
			headerBuf.writeUInt32LE(nameBuf.byteLength, 0);
			nameBuf.copy(headerBuf, 4);
			headerBuf.writeBigUInt64LE(BigInt(serialized.byteLength), 4 + nameBuf.byteLength);

			const frame = Buffer.concat([headerBuf, serialized]);
			frames.push({ name, type: typeName, frame, payloadBytes: serialized.byteLength });
		}

		// Enforce total maxBytes budget
		const chunks: Buffer[] = [SNAPSHOT_MAGIC];
		let totalBytes = SNAPSHOT_MAGIC.byteLength;

		for (const item of frames) {
			if (totalBytes + item.frame.byteLength > maxBytes) {
				skipped.push({
					name: item.name,
					type: item.type,
					reason: "exceeds_max_bytes",
					size_bytes: item.payloadBytes,
				});
				if (pruneOversized) {
					delete g[item.name];
					_userGlobals.delete(item.name);
					pruned.push({ name: item.name, type: item.type, size_bytes: item.payloadBytes });
				}
				continue;
			}
			chunks.push(item.frame);
			totalBytes += item.frame.byteLength;
			saved.push(item.name);
			types[item.name] = item.type;
		}

		const finalBuffer = Buffer.concat(chunks);
		fs.mkdirSync(path.dirname(targetPath), { recursive: true });
		const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
		fs.writeFileSync(tmpPath, finalBuffer);
		fs.renameSync(tmpPath, targetPath);

		const manifestData = {
			version: 1,
			format: "apollo-cli-kernel-snapshot-v1",
			created_at: new Date().toISOString(),
			saved,
			types,
			skipped,
			pruned,
			total_bytes: finalBuffer.byteLength,
			max_bytes: maxBytes,
			max_variable_bytes: maxVariableBytes,
		};

		if (manifestPath) {
			fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
			const tmpManifest = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
			fs.writeFileSync(tmpManifest, `${JSON.stringify(manifestData, null, 2)}\n`, "utf8");
			fs.renameSync(tmpManifest, manifestPath);
		}

		_sendProto({
			id,
			event: "done",
			status: "ok",
			path: targetPath,
			manifest_path: manifestPath,
			saved,
			skipped,
			pruned,
			bytes: totalBytes,
			total_bytes: finalBuffer.byteLength,
			max_bytes: maxBytes,
			max_variable_bytes: maxVariableBytes,
		});
	} catch (err) {
		_sendProto({
			id,
			event: "done",
			status: "error",
			reason: err instanceof Error ? err.message : String(err),
		});
	}
}

export const MAX_RESTORE_VERIFY_DEPTH = 3;

export interface VerifyRestoredResult {
	verified: boolean;
	reason?: string;
}

const BUILTIN_PLAIN_TYPES = new Set([
	"Object",
	"Array",
	"Map",
	"Set",
	"Date",
	"RegExp",
	"ArrayBuffer",
	"null",
	"undefined",
	"number",
	"string",
	"boolean",
	"bigint",
	"symbol",
]);

export function _verifyRestoredGlobal(
	_name: string,
	value: unknown,
	originalType?: string,
	depth = 0,
	visited = new WeakSet<object>(),
): VerifyRestoredResult {
	if (value === null || value === undefined) {
		return { verified: true };
	}

	const t = typeof value;
	if (t === "number" || t === "string" || t === "boolean" || t === "bigint" || t === "symbol") {
		return { verified: true };
	}

	if (t === "function") {
		return { verified: false, reason: "function_unpicklable" };
	}

	if (t !== "object") {
		return { verified: true };
	}

	const obj = value as object;
	if (visited.has(obj)) {
		return { verified: true };
	}
	visited.add(obj);

	if (depth >= MAX_RESTORE_VERIFY_DEPTH) {
		return { verified: false, reason: "complex_structure" };
	}

	// Class instance prototype loss detection:
	// If manifest recorded an original class type that is not a builtin plain container,
	// but the restored object has Object.prototype as its prototype, its class methods were lost.
	const proto = Object.getPrototypeOf(obj);
	if (proto === Object.prototype) {
		if (originalType && !BUILTIN_PLAIN_TYPES.has(originalType) && !ArrayBuffer.isView(obj)) {
			return { verified: false, reason: "prototype_lost" };
		}
		const constructorName = (obj as { constructor?: { name?: unknown } }).constructor?.name;
		if (constructorName && typeof constructorName === "string" && constructorName !== "Object") {
			return { verified: false, reason: "prototype_lost" };
		}
	}

	if (Array.isArray(obj)) {
		for (let i = 0; i < Math.min(obj.length, 50); i++) {
			const res = _verifyRestoredGlobal(_name, obj[i], undefined, depth + 1, visited);
			if (!res.verified) return res;
		}
		return { verified: true };
	}

	if (obj instanceof Set) {
		let count = 0;
		for (const item of obj) {
			if (++count > 50) break;
			const res = _verifyRestoredGlobal(_name, item, undefined, depth + 1, visited);
			if (!res.verified) return res;
		}
		return { verified: true };
	}

	if (obj instanceof Map) {
		let count = 0;
		for (const [k, v] of obj) {
			if (++count > 50) break;
			const keyRes = _verifyRestoredGlobal(_name, k, undefined, depth + 1, visited);
			if (!keyRes.verified) return keyRes;
			const valRes = _verifyRestoredGlobal(_name, v, undefined, depth + 1, visited);
			if (!valRes.verified) return valRes;
		}
		return { verified: true };
	}

	if (obj instanceof Date || obj instanceof RegExp || ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) {
		return { verified: true };
	}

	// Plain object properties
	const keys = Object.keys(obj);
	for (let i = 0; i < Math.min(keys.length, 50); i++) {
		const k = keys[i];
		const propVal = (obj as Record<string, unknown>)[k];
		const res = _verifyRestoredGlobal(_name, propVal, undefined, depth + 1, visited);
		if (!res.verified) return res;
	}

	return { verified: true };
}

export function handleRestore(msg: Record<string, unknown>): void {
	const id = String(msg.id ?? "");
	const sourcePath = typeof msg.path === "string" ? msg.path : "";

	if (!sourcePath || !fs.existsSync(sourcePath)) {
		_sendProto({
			id,
			event: "done",
			status: "ok",
			reason: "snapshot not found",
			restored: [],
			verified: [],
			unverified: [],
			failed: [],
		});
		return;
	}

	try {
		let snapshotTypes: Record<string, string> = {};
		const explicitManifestPath = typeof msg.manifest_path === "string" ? msg.manifest_path : "";
		const candidateManifestPaths = [
			explicitManifestPath,
			sourcePath.replace(/\.(snap|dill)$/, ".json"),
			path.join(path.dirname(sourcePath), "kernel-state.json"),
		].filter(Boolean);

		for (const mPath of candidateManifestPaths) {
			if (fs.existsSync(mPath)) {
				try {
					const manifestJson = JSON.parse(fs.readFileSync(mPath, "utf8"));
					if (manifestJson && typeof manifestJson.types === "object" && manifestJson.types !== null) {
						snapshotTypes = manifestJson.types as Record<string, string>;
						break;
					}
				} catch {
					// Fall back gracefully if manifest is not valid JSON
				}
			}
		}

		const buf = fs.readFileSync(sourcePath);
		let offset = 0;

		if (buf.subarray(0, SNAPSHOT_MAGIC.byteLength).equals(SNAPSHOT_MAGIC)) {
			offset = SNAPSHOT_MAGIC.byteLength;
		} else if (buf.subarray(0, LEGACY_SNAPSHOT_MAGIC.byteLength).equals(LEGACY_SNAPSHOT_MAGIC)) {
			offset = LEGACY_SNAPSHOT_MAGIC.byteLength;
		} else {
			throw new Error("Invalid snapshot header magic");
		}

		const restored: string[] = [];
		const verified: string[] = [];
		const unverified: Array<{ name: string; reason: string }> = [];
		const failed: Array<{ name: string; reason: string }> = [];
		const g = globalThis as Record<string, unknown>;

		while (offset < buf.byteLength) {
			if (offset + 4 > buf.byteLength) {
				throw new Error("Truncated snapshot frame (name length)");
			}
			const nameLen = buf.readUInt32LE(offset);
			offset += 4;

			if (offset + nameLen + 8 > buf.byteLength) {
				throw new Error("Truncated snapshot frame (name or payload length)");
			}
			const name = buf.subarray(offset, offset + nameLen).toString("utf8");
			offset += nameLen;

			const payloadLen = Number(buf.readBigUInt64LE(offset));
			offset += 8;

			if (offset + payloadLen > buf.byteLength) {
				throw new Error(`Truncated snapshot frame payload for '${name}'`);
			}
			const payload = buf.subarray(offset, offset + payloadLen);
			offset += payloadLen;

			if (_RESERVED_NAMES.has(name)) {
				failed.push({ name, reason: "reserved_name" });
				continue;
			}

			try {
				const value = v8.deserialize(payload);
				g[name] = value;
				recordUserGlobal(name);
				restored.push(name);

				const originalType = snapshotTypes[name];
				const probe = _verifyRestoredGlobal(name, value, originalType);
				if (probe.verified) {
					verified.push(name);
				} else {
					unverified.push({ name, reason: probe.reason ?? "verification_failed" });
				}
			} catch (err) {
				failed.push({
					name,
					reason: err instanceof Error ? err.message : "deserialize_failed",
				});
			}
		}

		_sendProto({
			id,
			event: "done",
			status: "ok",
			path: sourcePath,
			restored,
			verified,
			unverified,
			failed,
		});
	} catch (err) {
		_sendProto({
			id,
			event: "done",
			status: "error",
			reason: err instanceof Error ? err.message : String(err),
		});
	}
}

export function handleListNames(msg: Record<string, unknown>): void {
	const id = String(msg.id ?? "");
	const g = globalThis as Record<string, unknown>;
	const names: string[] = [];
	const types: Record<string, string> = {};

	for (const name of [..._userGlobals].sort()) {
		if (_RESERVED_NAMES.has(name) || name.startsWith("_")) continue;
		if (!(name in g)) continue;
		names.push(name);
		types[name] = _classifyType(g[name]);
	}

	_sendProto({
		id,
		event: "done",
		status: "ok",
		names,
		types,
	});
}

function _setupStdoutStderrInterception(): void {
	const origStdoutWrite = process.stdout.write.bind(process.stdout);

	_protoWrite = (line: string) => {
		origStdoutWrite(`${line}\n`);
	};

	const interceptWrite = (
		streamName: "stdout" | "stderr",
		chunk: unknown,
		encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
		cb?: (err?: Error | null) => void,
	): boolean => {
		const text =
			typeof chunk === "string"
				? chunk
				: Buffer.isBuffer(chunk)
					? chunk.toString(typeof encodingOrCb === "string" ? encodingOrCb : "utf8")
					: String(chunk);
		_sendStream(streamName, text);
		const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb;
		if (callback) callback(null);
		return true;
	};

	process.stdout.write = ((chunk: unknown, encodingOrCb?: unknown, cb?: unknown) =>
		interceptWrite(
			"stdout",
			chunk,
			encodingOrCb as BufferEncoding | ((err?: Error | null) => void),
			cb as (err?: Error | null) => void,
		)) as typeof process.stdout.write;

	process.stderr.write = ((chunk: unknown, encodingOrCb?: unknown, cb?: unknown) =>
		interceptWrite(
			"stderr",
			chunk,
			encodingOrCb as BufferEncoding | ((err?: Error | null) => void),
			cb as (err?: Error | null) => void,
		)) as typeof process.stderr.write;

	const formatConsoleArgs = (args: unknown[]): string => {
		return `${args.map((a) => (typeof a === "string" ? a : _formatValue(a))).join(" ")}\n`;
	};

	console.log = (...args: unknown[]) => _sendStream("stdout", formatConsoleArgs(args));
	console.info = (...args: unknown[]) => _sendStream("stdout", formatConsoleArgs(args));
	console.debug = (...args: unknown[]) => _sendStream("stdout", formatConsoleArgs(args));
	console.warn = (...args: unknown[]) => _sendStream("stderr", formatConsoleArgs(args));
	console.error = (...args: unknown[]) => _sendStream("stderr", formatConsoleArgs(args));
}

function _setupSkillModuleResolver(): void {
	const req = moduleBuiltin.createRequire(path.join(process.cwd(), "__repl__.js"));
	(globalThis as Record<string, unknown>).__apollo_require__ = req;
	(globalThis as Record<string, unknown>).require = req;

	const skillImportMap = new Map<string, string>();
	const skillsDirEnv = process.env.APOLLO_SKILLS_DIR;
	const candidateSkillRoots: string[] = [];
	if (skillsDirEnv) {
		for (const part of skillsDirEnv.split(path.delimiter)) {
			if (part.trim()) candidateSkillRoots.push(part.trim());
		}
	}
	candidateSkillRoots.push(path.resolve(process.cwd(), "packages/coding-agent/skills"));

	for (const root of candidateSkillRoots) {
		try {
			if (!fs.existsSync(root)) continue;
			for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				const skillDir = path.join(root, entry.name);
				const underscored = entry.name.replace(/-/g, "_");
				const candidates = [
					path.join(skillDir, "src", underscored, "mod.ts"),
					path.join(skillDir, "src", entry.name, "mod.ts"),
					path.join(skillDir, "src", "mod.ts"),
				];
				for (const c of candidates) {
					if (fs.existsSync(c)) {
						skillImportMap.set(entry.name, c);
						skillImportMap.set(underscored, c);
						skillImportMap.set(`@apollo/skill-${entry.name}`, c);
						break;
					}
				}
			}
		} catch {
			// Ignore unreadable skill directories
		}
	}

	(globalThis as Record<string, unknown>).__apollo_import__ = async (specifier: string): Promise<unknown> => {
		const mapped = skillImportMap.get(specifier);
		if (mapped) {
			return req(mapped);
		}
		try {
			return req(specifier);
		} catch {
			// Fallback to dynamic import via Function constructor so no static inline import is used
			const dynamicImporter = new Function("s", "return import(s)") as (s: string) => Promise<unknown>;
			return await dynamicImporter(specifier);
		}
	};
}

function _startParentWatchdog(shutdownFn: () => void): void {
	const rawOwnerPid = process.env.APOLLO_KERNEL_OWNER_PID || process.env.PRIME_AGENT_KERNEL_OWNER_PID;
	if (!rawOwnerPid) return;
	const ownerPid = Number.parseInt(rawOwnerPid, 10);
	if (!Number.isFinite(ownerPid) || ownerPid <= 1) return;

	const timer = setInterval(() => {
		try {
			process.kill(ownerPid, 0);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ESRCH") {
				clearInterval(timer);
				shutdownFn();
			}
		}
	}, 1000);
	timer.unref();
}

export async function startReplLoop(preloadGlobals?: Record<string, unknown>): Promise<void> {
	if (preloadGlobals) {
		const g = globalThis as Record<string, unknown>;
		for (const [k, v] of Object.entries(preloadGlobals)) {
			g[k] = v;
			_builtinGlobals.add(k);
		}
	}

	_registerReplBridge({
		isActive: is_active,
		emit: (data) => {
			const id = _getActiveCellId();
			if (id !== null) {
				_sendProto({ id, event: "display", data, metadata: {} });
			}
		},
		hostRequest: (data) => host_request(data),
		sendRawEvent: (evt) => _sendProto(evt),
		currentCellCompletionBarrier: () => _getActiveExecution()?.completionBarrier ?? null,
	});

	_setupSkillModuleResolver();
	_setupStdoutStderrInterception();

	if (!process.env.APOLLO_SESSION_KERNEL_PID) {
		process.env.APOLLO_SESSION_KERNEL_PID = String(process.pid);
	}

	const shutdown = () => {
		try {
			_kill_live_handles();
		} catch {
			// Ignore cleanup error
		}
		process.exit(0);
	};

	_startParentWatchdog(shutdown);

	process.on("SIGTERM", shutdown);
	process.on("SIGHUP", shutdown);
	process.on("SIGINT", () => {
		// Interrupt active cell if running
		const exec = _getActiveExecution();
		if (exec) {
			_kill_live_handles();
			exec.interrupt();
		}
	});

	const denoObj = (globalThis as unknown as { Deno?: { version?: { deno?: string } } }).Deno;
	const denoVersion = typeof denoObj === "object" && denoObj?.version?.deno ? denoObj.version.deno : process.versions.node;

	_sendProto({
		event: "ready",
		protocol: PROTOCOL_VERSION,
		deno: denoVersion,
		node: process.versions.node,
		python: denoVersion,
	});

	const rl = readline.createInterface({
		input: process.stdin,
		terminal: false,
	});

	let activeExecutionQueue = Promise.resolve();

	rl.on("line", (line) => {
		const trimmed = line.trim();
		if (!trimmed) return;

		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			return;
		}

		const type = String(msg.type ?? "");

		if (type === "host_reply") {
			const reqId = typeof msg.id === "string" ? msg.id : "";
			const pending = reqId ? _pendingRequests.get(reqId) : undefined;
			if (pending) {
				_pendingRequests.delete(reqId);
				if (pending.timer) clearTimeout(pending.timer);
				pending.resolve(_isPlainRecord(msg.data) ? msg.data : {});
			}
			return;
		}

		if (type === "interrupt") {
			_kill_live_handles();
			const exec = _getActiveExecution();
			if (exec) {
				exec.interrupt();
			}
			return;
		}

		if (type === "shutdown") {
			shutdown();
			return;
		}

		if (type === "snapshot") {
			activeExecutionQueue = activeExecutionQueue.then(() => {
				handleSnapshot(msg);
			});
			return;
		}

		if (type === "restore") {
			activeExecutionQueue = activeExecutionQueue.then(() => {
				handleRestore(msg);
			});
			return;
		}

		if (type === "list_names") {
			activeExecutionQueue = activeExecutionQueue.then(() => {
				handleListNames(msg);
			});
			return;
		}

		if (type === "execute") {
			const id = String(msg.id ?? `cell-${Date.now()}`);
			const code = typeof msg.code === "string" ? msg.code : "";
			const silent = Boolean(msg.silent);
			activeExecutionQueue = activeExecutionQueue.then(() => executeCell(id, code, silent));
		}
	});

	rl.on("close", () => {
		const hadPending = _pendingRequests.size > 0;
		_failPendingHostRequests();
		if (hadPending) {
			// Cells awaiting host requests need one beat to surface the
			// rejection before the process exits.
			setTimeout(shutdown, 25);
		} else {
			shutdown();
		}
	});
}
