import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { IMAGE_MIME_TYPES } from "../../utils/mime.js";
import { resolveKernelBashShell } from "../../utils/shell.js";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.js";
import { withKernelBootPermit } from "../kernel/boot-gate.js";
import type { KernelBootstrapProgressHandler } from "../kernel/bootstrap.js";
import {
	type ExecuteResult,
	type HostRequestHandlers,
	type KernelAttachment,
	KernelBusyAfterInterruptError,
	type KernelClient,
	type KernelDiffDisplay,
	type KernelSentAgentMessage,
	ReplKernelManager,
} from "../kernel/index.js";
import { manifestPathIn, type RestoreResult, snapshotPathIn } from "../kernel/state-snapshot.js";
import type { PythonSkillRuntimeInfo } from "../skills.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const RLM_BOOTSTRAP_HEADER_CODE = `
if (typeof process === "object" && process.env) {
    process.env["NO_COLOR"] = "1";
}
`.trim();

const RLM_BOOTSTRAP_RUNTIME_CODE = `
(() => {
    const g = globalThis;
    if (typeof g.rlm === "undefined") {
        const raiseMissing = () => {
            throw new Error(
                "apollo-cli-runtime is not initialized in this kernel. " +
                "Ensure apollo-cli-runtime/src/rlm/mod.ts is available."
            );
        };
        g.rlm = {
            spawn: raiseMissing,
            find_models: raiseMissing,
            findModels: raiseMissing,
            create_session: raiseMissing,
            createSession: raiseMissing,
            list_subagents: raiseMissing,
            listSubagents: raiseMissing,
            delete_subagent: raiseMissing,
            deleteSubagent: raiseMissing,
        };
    }
    if (typeof g.bash === "undefined") {
        g.bash = () => {
            throw new Error("bash runtime is not initialized in this kernel.");
        };
    }
})();
`.trim();

/**
 * Line the runtime bootstrap prints (once, after the skill import loop) when
 * one or more pre-imported Python/JS skills failed to import. The host scans the
 * bootstrap cell's stdout for this marker so unavailable skills reach the
 * model instead of failing only on first call.
 */
export const PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER = "__PRIME_AGENT_PYTHON_SKILL_IMPORT_ERRORS__";
export const ISCRIPT_SKILL_IMPORT_ERROR_REPORT_MARKER = PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER;

/** Map of skill import name -> import error, parsed from a bootstrap cell's stdout. */
export type UnavailablePythonSkills = Record<string, string>;
export type UnavailableIScriptSkills = UnavailablePythonSkills;

/** Extract the unavailable-skill report a bootstrap cell printed, or undefined. */
export function parseUnavailablePythonSkills(stdout: string): UnavailablePythonSkills | undefined {
	const at = stdout.indexOf(PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER);
	if (at < 0) return undefined;
	const raw = stdout.slice(at + PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER.length).trim();
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const errors: UnavailablePythonSkills = {};
	for (const [name, error] of Object.entries(parsed)) {
		if (typeof error === "string" && error.length > 0) {
			errors[name] = error;
		}
	}
	return Object.keys(errors).length > 0 ? errors : undefined;
}

export const parseUnavailableIScriptSkills = parseUnavailablePythonSkills;

export function buildIScriptBootstrapCode(pythonSkills: readonly PythonSkillRuntimeInfo[] = []): string {
	const baseCode = [RLM_BOOTSTRAP_HEADER_CODE, RLM_BOOTSTRAP_RUNTIME_CODE].join("\n\n");
	const importNames = [...new Set(pythonSkills.map((skill) => skill.importName))];
	if (importNames.length === 0) {
		return baseCode;
	}

	return `
${baseCode}

await (async () => {
    const importErrors = {};
    for (const skillName of ${JSON.stringify(importNames)}) {
        try {
            if (typeof globalThis.__apollo_import__ === "function") {
                const mod = await globalThis.__apollo_import__(skillName);
                // ESM skills arrive as a module namespace; unwrap the default
                // export so the bare global is callable, and merge any
                // non-colliding named exports.
                const fn = (mod && mod.default !== undefined) ? mod.default : mod;
                globalThis[skillName] = fn;
                if (mod && typeof mod === "object") {
                    for (const [key, value] of Object.entries(mod)) {
                        if (key === "default" || key === "__esModule") continue;
                        if (!(key in globalThis)) globalThis[key] = value;
                    }
                }
            }
        } catch (err) {
            const errText = String(err?.message || err);
            importErrors[skillName] = errText;
            globalThis[skillName] = async () => {
                throw new Error(\`Skill \${skillName} is unavailable in this kernel: \${errText}\`);
            };
        }
    }
    if (Object.keys(importErrors).length > 0) {
        console.log("${PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER}" + JSON.stringify(importErrors));
    }
})();
`.trim();
}

/** Alias for {@link buildIScriptBootstrapCode}; kept for existing call sites. */
export const buildRlmBootstrapCode = buildIScriptBootstrapCode;

/**
 * Bootstrap for the Python fallback kernel. The Python runtime starts with an
 * empty cell namespace, so this seeds the runtime globals (rlm, mcp, bash,
 * emit, host_request) and imports every pre-installed skill module into the
 * namespace, printing the shared failure marker for any import that fails.
 */
export function buildPythonBootstrapCode(pythonSkills: readonly PythonSkillRuntimeInfo[] = []): string {
	const importNames = [...new Set(pythonSkills.map((skill) => skill.importName))];
	const skillLoop =
		importNames.length === 0
			? ""
			: `
_skill_import_errors = {}
for _skill_name in ${JSON.stringify(importNames)}:
    try:
        globals()[_skill_name] = _bootstrap_importlib.import_module(_skill_name)
    except Exception as _skill_err:
        _skill_import_errors[_skill_name] = str(_skill_err)
        globals()[_skill_name] = _bootstrap_unavailable(_skill_name, str(_skill_err))
if _skill_import_errors:
    print("${PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER}" + _bootstrap_json.dumps(_skill_import_errors))
`.trim();

	return `
import importlib as _bootstrap_importlib
import json as _bootstrap_json

import rlm as _bootstrap_rlm
import rlm.mcp as _bootstrap_mcp

def _bootstrap_unavailable(name, error_text):
    class _Unavailable:
        def __getattr__(self, _attr):
            raise AttributeError(f"Skill {name!r} is unavailable in this kernel: {error_text}")
    return _Unavailable()

globals().setdefault("rlm", _bootstrap_rlm)
globals().setdefault("mcp", _bootstrap_mcp)
globals().setdefault("bash", _bootstrap_rlm.bash)
globals().setdefault("emit", _bootstrap_rlm.emit)
globals().setdefault("host_request", _bootstrap_rlm.host_request)
${skillLoop}
`.trim();
}

export const iscriptSchema = Type.Object({
	code: Type.String({
		description:
			"TypeScript / JavaScript code to execute in the persistent IScript (Deno/Node) REPL. Top-level await and !cmd shortcuts are supported. Use the target project's own environment for project imports, tests, scripts, CLIs, and dependency checks instead of direct kernel imports.",
	}),
});

export const ipythonSchema = iscriptSchema;

const BUSY_KERNEL_WAIT_CHOICE = "Wait and preserve state";
const BUSY_KERNEL_KILL_CHOICE = "Kill kernel and restart";
const BUSY_KERNEL_PROMPT = [
	"Interrupted IScript cell is still running",
	"Ctrl+C sent an interrupt, but the previous cell has not stopped yet. A new command cannot start until it finishes.",
	"Waiting preserves the current kernel state. Killing restarts the kernel and loses in-memory variables, imports, and running tasks.",
].join("\n");
const KERNEL_RESTART_NOTICE = [
	"<iscript_kernel_reset>",
	"The IScript kernel was restarted after a previous interrupted cell kept running. Variables, imports, async tasks, and open resources from before the restart are no longer available; recreate them before using them.",
	"</iscript_kernel_reset>",
].join("\n");

function createAbortError(): Error {
	return new Error("IScript execution aborted");
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, onAbort?: () => void): Promise<T> {
	if (!signal) {
		return promise;
	}
	if (signal.aborted) {
		onAbort?.();
		return Promise.reject(createAbortError());
	}
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const cleanup = () => signal.removeEventListener("abort", abort);
		const abort = () => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			onAbort?.();
			reject(createAbortError());
		};
		signal.addEventListener("abort", abort, { once: true });
		promise.then(
			(value) => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				reject(error);
			},
		);
	});
}

function createLinkedAbortSignal(sources: readonly (AbortSignal | undefined)[]): {
	signal: AbortSignal;
	cleanup: () => void;
} {
	const controller = new AbortController();
	const cleanups: Array<() => void> = [];
	const abort = () => controller.abort();
	for (const source of sources) {
		if (!source) {
			continue;
		}
		if (source.aborted) {
			controller.abort();
			continue;
		}
		const listener = () => abort();
		source.addEventListener("abort", listener, { once: true });
		cleanups.push(() => source.removeEventListener("abort", listener));
	}
	return {
		signal: controller.signal,
		cleanup: () => {
			for (const cleanup of cleanups) {
				cleanup();
			}
		},
	};
}

function setWorkingMessage(ctx: ExtensionContext | undefined, message?: string): void {
	try {
		ctx?.ui.setWorkingMessage(message);
	} catch {
		// Stale UI context; cosmetic only.
	}
}

export type IScriptToolInput = Static<typeof iscriptSchema>;
export type IpythonToolInput = IScriptToolInput;

export interface IScriptToolDetails {
	durationMs?: number;
	status?: "ok" | "error" | "aborted" | "starting";
	errorEname?: string;
	stdout?: string;
	stderr?: string;
	result?: string;
	/** Output that arrived without this cell's id (threads, other cells' leftovers), shown separately from stdout. */
	backgroundOutput?: string;
	/** Diffs streamed from file edits, rendered by the cell view. */
	diffs?: KernelDiffDisplay[];
	/** Media attachments loaded into context (e.g. by the attach-image skill). */
	attachments?: KernelAttachment[];
	/** Agent messages sent from this cell. */
	sentAgentMessages?: KernelSentAgentMessage[];
	/** True when this result came after killing and restarting a busy kernel. */
	kernelRestarted?: boolean;
	error?: {
		ename: string;
		evalue: string;
		traceback: string[];
	};
}

export type IpythonToolDetails = IScriptToolDetails;

export interface IScriptToolOptions {
	/** Python or Deno override. */
	python?: string;
	env?: Record<string, string>;
	/** Command prefix prepended to every bash() command. */
	commandPrefix?: string;
	/** Shell used by bash(). */
	shellPath?: string;
	sessionId?: string;
	/** Typed host request handlers for the kernel↔host bridge (rlm.run, goal.*, …). */
	hostHandlers?: HostRequestHandlers;
	pythonSkills?: readonly PythonSkillRuntimeInfo[];
	/** Per-session artifact dir where the kernel namespace snapshot is stored. Omit to disable snapshots. */
	snapshotDir?: string;
	/** Resolves before this kernel starts — e.g. the previous provisioner's dispose, so a
	 * /reload's old-kernel snapshot flush can't race the new kernel's restore. */
	readyGate?: Promise<unknown>;
	/**
	 * Fires once per kernel start when a previous session's namespace was revived
	 * (some names restored or some failed), so the session can tell the model.
	 */
	onRestore?: (result: RestoreResult) => void;
	/**
	 * Fires once per kernel start when installed Python skills failed to import
	 * into the kernel (skill import name -> import error), so the session can tell
	 * the model before it wastes turns calling them.
	 */
	onUnavailableSkills?: (errors: UnavailablePythonSkills) => void;
	/** Fires when the kernel's last live background bash() handle settles, so owed continuations can resume. */
	onBackgroundWorkSettled?: () => void;
	onLateSentAgentMessage?: (toolCallId: string, message: KernelSentAgentMessage) => void;
	/** Shared provisioner owning the kernel lifecycle. When provided, the remaining options are ignored. */
	provisioner?: IScriptKernelProvisioner;
}

export type IpythonToolOptions = IScriptToolOptions;

/**
 * Owns the lazy create+start+runtime-bootstrap of one session's IScript kernel.
 *
 * Concurrent ensure() calls await the same in-flight startup, a failed startup
 * clears the memo so the next call retries fresh, and progress listeners can
 * attach mid-flight (a tool call racing a background prewarm()).
 */
export class IScriptKernelProvisioner {
	private managerPromise?: Promise<KernelClient>;
	private startedManager?: KernelClient;
	private readonly startupListeners = new Set<KernelBootstrapProgressHandler>();
	private lastStartupMessage?: string;
	private _lastRestore?: RestoreResult;
	private readonly disposeController = new AbortController();
	/** Snapshot policy of the dispose that aborted a startup, honored by startKernel's failure teardown. */
	private disposeSnapshot = true;

	constructor(
		private readonly cwd: string,
		private readonly options?: Omit<IScriptToolOptions, "provisioner">,
	) {}

	/** The kernel manager, once a startup has completed successfully. */
	get manager(): KernelClient | undefined {
		return this.startedManager;
	}

	/** Result of reviving a prior session's namespace on the last kernel start, if any. */
	get lastRestore(): RestoreResult | undefined {
		return this._lastRestore;
	}

	/** Start the kernel in the background. Failures are swallowed here and surface on the next ensure(). */
	prewarm(): void {
		void this.ensure().catch(() => {});
	}

	/** Whether a kernel has finished starting and is currently running. */
	get hasRunningKernel(): boolean {
		return this.startedManager?.isRunning ?? false;
	}

	/** Remove live variables above the snapshot's per-variable size limit. */
	async pruneOversizedVariables(): Promise<string[] | null> {
		const m = this.startedManager ?? (await this.managerPromise?.catch(() => undefined));
		const result = await m?.pruneOversizedVariables();
		return result ? (result.pruned ?? []) : null;
	}

	/** Live user-defined names in the kernel namespace, or null if listing failed / no kernel. */
	async listNamespaceNames(signal?: AbortSignal): Promise<string[] | null> {
		const m = this.startedManager ?? (await this.managerPromise?.catch(() => undefined));
		return (await m?.listNamespaceNames(signal)) ?? null;
	}

	/** Dispose the kernel owned by this provisioner, including one still starting up. */
	async dispose(options?: { snapshot?: boolean }): Promise<void> {
		this.disposeSnapshot = options?.snapshot ?? true;
		// Drops a still-queued boot out of the semaphore and short-circuits an
		// in-flight startKernel before it spawns, so a disposed session's boot
		// doesn't waste a slot during a fan-out.
		this.disposeController.abort();
		const pending = this.managerPromise;
		this.managerPromise = undefined;
		this.startedManager = undefined;
		if (!pending) return;
		try {
			const m = await pending;
			await m.shutdown({ snapshot: this.disposeSnapshot, drainHostRequests: true });
		} catch {
			// a failed startup already cleaned up after itself
		}
	}

	async kill(): Promise<void> {
		const pending = this.managerPromise;
		this.managerPromise = undefined;
		this.startedManager = undefined;
		if (!pending) return;
		try {
			const m = await pending;
			await m.kill();
		} catch {
			// a failed startup already cleaned up after itself
		}
	}

	ensure(onProgress?: KernelBootstrapProgressHandler, signal?: AbortSignal): Promise<KernelClient> {
		if (signal?.aborted) {
			return Promise.reject(createAbortError());
		}
		// Only a terminally dead kernel drops the memo; a repairing manager (idle/starting) recovers itself.
		if (this.startedManager?.isDefunct) {
			this.managerPromise = undefined;
			this.startedManager = undefined;
		}
		let cleanupProgressListener: (() => void) | undefined;
		if (onProgress && !this.startedManager) {
			this.startupListeners.add(onProgress);
			cleanupProgressListener = () => {
				this.startupListeners.delete(onProgress);
				signal?.removeEventListener("abort", cleanupProgressListener!);
			};
			signal?.addEventListener("abort", cleanupProgressListener, { once: true });
			// Joining an in-flight startup: replay the current stage.
			if (this.managerPromise && this.lastStartupMessage) {
				onProgress(this.lastStartupMessage);
			}
		}
		if (!this.managerPromise) {
			const startup = this.startKernel(signal);
			this.managerPromise = startup;
			startup.then(
				(m) => {
					if (this.managerPromise === startup) {
						this.startedManager = m;
					}
					this.settleStartup();
				},
				() => {
					// Clear the memo so the next ensure() retries instead of
					// rethrowing a cached rejection forever.
					if (this.managerPromise === startup) {
						this.managerPromise = undefined;
					}
					this.settleStartup();
				},
			);
		}
		return raceWithAbort(this.managerPromise, signal).finally(() => {
			cleanupProgressListener?.();
		});
	}

	private settleStartup(): void {
		this.startupListeners.clear();
		this.lastStartupMessage = undefined;
	}

	private emitStartupProgress(message: string): void {
		this.lastStartupMessage = message;
		for (const listener of [...this.startupListeners]) {
			listener(message);
		}
	}

	private async startKernel(signal?: AbortSignal): Promise<KernelClient> {
		const startupAbort = createLinkedAbortSignal([this.disposeController.signal, signal]);
		const startupSignal = startupAbort.signal;
		// Wait for a previous provisioner (e.g. on /reload) to finish disposing — and
		// flushing its final snapshot — before we read that snapshot back, so the two
		// kernels can't race over the same on-disk file. Guarded so the common
		// no-gate path stays synchronous (callers rely on prompt startup progress).
		try {
			if (this.options?.readyGate) {
				await raceWithAbort(
					this.options.readyGate.catch(() => {}),
					startupSignal,
				);
			}
			const snapshotDir = this.options?.snapshotDir;
			// Always inject an absolute trusted shell (undefined only on win32
			// without bash, where the runtime's teaching error fires instead).
			const shellPath = resolveKernelBashShell(this.options?.shellPath);
			const commandPrefix = this.options?.commandPrefix;
			const m = new ReplKernelManager({
				python: this.options?.python,
				cwd: this.cwd,
				// bash() reads these to pick its shell and command prefix.
				env: {
					...this.options?.env,
					...(shellPath ? { PRIME_AGENT_BASH_SHELL: shellPath } : {}),
					...(commandPrefix ? { PRIME_AGENT_BASH_COMMAND_PREFIX: commandPrefix } : {}),
				},
				sessionId: this.options?.sessionId,
				hostHandlers: this.options?.hostHandlers,
				onBackgroundWorkSettled: this.options?.onBackgroundWorkSettled,
				pythonSkills: this.options?.pythonSkills,
				// Only persistent sessions (which have an artifact dir) get a revivable snapshot.
				snapshot: snapshotDir
					? { path: snapshotPathIn(snapshotDir), manifestPath: manifestPathIn(snapshotDir) }
					: undefined,
				stderrLogPath: snapshotDir ? join(snapshotDir, "kernel-stderr.log") : undefined,
			});
			let pendingRestore: RestoreResult | undefined;
			let snapshotExisted = false;
			try {
				// Emitted synchronously (before the permit await) so a listener attaching
				// mid-flight can replay the current stage.
				this.emitStartupProgress("Starting Python kernel...");
				// Only the process spawn + port resolve contends for OS resources under a
				// fan-out, and it is bounded by start()'s own timeouts — so the permit
				// covers only start(). Restore/bootstrap run per-kernel afterwards and are
				// unbounded execute()s; holding the global permit across them could pin it
				// forever on a wedged bootstrap and starve every other session's boot.
				await withKernelBootPermit(() => {
					// Disposed while queued for the permit — don't spawn a kernel nobody wants.
					if (startupSignal.aborted) throw new Error("Kernel provisioner disposed before start");
					return m.start({
						onBootstrapProgress: (message) => this.emitStartupProgress(message),
						signal: startupSignal,
					});
				}, startupSignal);
				// Revive a prior session's namespace before the bootstrap, so the bootstrap
				// then overwrites live handles (rlm, skills) on top of anything restored.
				if (snapshotDir) {
					snapshotExisted = existsSync(snapshotPathIn(snapshotDir));
					this.emitStartupProgress("Restoring Python state...");
					const restore = await raceWithAbort(m.restoreState(), startupSignal);
					if (snapshotExisted) {
						pendingRestore = restore ?? { restored: [], failed: [], path: snapshotPathIn(snapshotDir) };
					}
				}
				this.emitStartupProgress("Preparing Python runtime...");
				// Built after start so it matches the kernel's actual dialect (the TS
				// runtime is preferred when resolvable; otherwise the Python fallback).
				const bootstrapCode = m.buildBootstrapCode();
				const bootstrap = await m.execute(bootstrapCode, {
					signal: startupSignal,
				});
				if (bootstrap.status !== "ok") {
					const details = [bootstrap.stderr, bootstrap.error?.traceback.join("\n")].filter(Boolean).join("\n");
					throw new Error(`Failed to initialize rlm runtime in the Python kernel:\n${details}`);
				}
				if (snapshotExisted) {
					m.markRestoredNamespaceFresh();
				}
				// Broken skills stay importable-looking placeholders; report them so the
				// model learns before its first call, not from the placeholder's error.
				const unavailableSkills = parseUnavailablePythonSkills(bootstrap.stdout);
				if (unavailableSkills) {
					this.options?.onUnavailableSkills?.(unavailableSkills);
				}
			} catch (error) {
				// Never leak the kernel process if startup fails after spawn — and never
				// surface the failure before the teardown (final snapshot flush included)
				// finished, or a replacement provisioner gated on this dispose could
				// race the still-flushing kernel over the same snapshot files.
				await m.shutdown({ snapshot: this.disposeSnapshot, drainHostRequests: true }).catch(() => undefined);
				throw error;
			}
			// Only tell the model what was revived once the kernel is actually usable —
			// a notice claiming restored state must never outlive a failed bootstrap.
			if (pendingRestore) {
				this._lastRestore = pendingRestore;
				this.options?.onRestore?.(pendingRestore);
			}
			return m;
		} finally {
			startupAbort.cleanup();
		}
	}
}

async function chooseBusyKernelAction(
	ctx: ExtensionContext | undefined,
	signal: AbortSignal | undefined,
): Promise<"wait" | "kill" | "cancel"> {
	if (!ctx?.hasUI) {
		return "cancel";
	}
	const choice = await ctx.ui.select(BUSY_KERNEL_PROMPT, [BUSY_KERNEL_WAIT_CHOICE, BUSY_KERNEL_KILL_CHOICE], {
		signal,
	});
	if (choice === BUSY_KERNEL_WAIT_CHOICE) {
		return "wait";
	}
	if (choice === BUSY_KERNEL_KILL_CHOICE) {
		return "kill";
	}
	return "cancel";
}

async function executeWithBusyKernelChoice(
	provisioner: IpythonKernelProvisioner,
	reportStartupProgress: KernelBootstrapProgressHandler,
	toolCallId: string,
	code: string,
	signal: AbortSignal | undefined,
	onStream: (chunk: string, name: "stdout" | "stderr") => void,
	onWorkingMessage: (message?: string) => void,
	onLateSentAgentMessage: ((toolCallId: string, message: KernelSentAgentMessage) => void) | undefined,
	ctx: ExtensionContext | undefined,
): Promise<{ result: ExecuteResult; kernelRestarted: boolean }> {
	let kernelRestarted = false;
	while (true) {
		const m = await provisioner.ensure(reportStartupProgress, signal);
		try {
			return {
				result: await m.execute(code, {
					signal,
					onStream,
					onLateSentAgentMessage: onLateSentAgentMessage
						? (message) => onLateSentAgentMessage(toolCallId, message)
						: undefined,
				}),
				kernelRestarted,
			};
		} catch (error) {
			if (!(error instanceof KernelBusyAfterInterruptError) || signal?.aborted) {
				throw error;
			}
			const action = await chooseBusyKernelAction(ctx, signal);
			if (action === "wait") {
				onWorkingMessage("Waiting for Python kernel...");
				continue;
			}
			if (action === "kill") {
				onWorkingMessage("Restarting Python kernel...");
				await provisioner.kill();
				kernelRestarted = true;
				continue;
			}
			throw error;
		}
	}
}

/** Turn kernel image attachments into `ImageContent` blocks; non-image types are dropped. */
export function imageBlocksFromAttachments(attachments: readonly KernelAttachment[] | undefined): ImageContent[] {
	if (!attachments) return [];
	return attachments
		.filter((a) => IMAGE_MIME_TYPES.has(a.mimeType))
		.map((a) => ({ type: "image", data: a.data, mimeType: a.mimeType }));
}

export const IpythonKernelProvisioner = IScriptKernelProvisioner;
export type IpythonKernelProvisioner = IScriptKernelProvisioner;

export function createIScriptToolDefinition(
	cwd: string,
	options?: IScriptToolOptions & { name?: string; label?: string },
): ToolDefinition<typeof iscriptSchema, IScriptToolDetails> {
	const provisioner = options?.provisioner ?? new IScriptKernelProvisioner(cwd, options);

	const toolName = options?.name ?? "iscript";
	return {
		name: toolName,
		label: options?.label ?? toolName,
		description:
			"Execute TypeScript / JavaScript code in a persistent IScript (Deno/Node) REPL. Top-level `await` and `!cmd` shortcuts are supported. Variables, imports, and loaded data persist across calls, and are revived on a best-effort basis when a session is resumed. Run shell commands with `bash('cmd')` / `await bash('cmd')` or `!cmd`. Project imports, tests, scripts, CLIs, and dependency checks should run through the target project's own environment.",
		promptSnippet: "iscript - persistent TypeScript/Deno REPL for code, state, and bash() orchestration",
		// The kernel is single-threaded — apollo must not run two iscript calls in parallel within a batch.
		executionMode: "sequential",
		parameters: iscriptSchema,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			let hasWorkingMessage = false;
			const setToolWorkingMessage = (message?: string) => {
				setWorkingMessage(ctx, message);
				hasWorkingMessage = message !== undefined;
			};
			const reportStartupProgress: KernelBootstrapProgressHandler = (message) => {
				setToolWorkingMessage(message);
				onUpdate?.({
					content: [{ type: "text", text: message }],
					details: { status: "starting" },
				});
			};

			try {
				const { result: r, kernelRestarted } = await executeWithBusyKernelChoice(
					provisioner,
					reportStartupProgress,
					toolCallId,
					params.code,
					signal,
					(chunk) => {
						onUpdate?.({
							content: [{ type: "text", text: chunk }],
							details: { status: "ok" },
						});
					},
					setToolWorkingMessage,
					options?.onLateSentAgentMessage,
					ctx,
				);

				let text = r.stdout;
				if (r.stderr) text += (text ? "\n" : "") + r.stderr;
				if (r.result) text += (text ? "\n" : "") + r.result;
				if (r.status === "error" && r.error) {
					text += (text ? "\n" : "") + r.error.traceback.join("\n");
				}
				if (r.backgroundOutput) {
					text += `${text ? "\n" : ""}[background output (unattributed)]\n${r.backgroundOutput}`;
				}
				if (kernelRestarted) {
					text = text ? `${KERNEL_RESTART_NOTICE}\n\n${text}` : KERNEL_RESTART_NOTICE;
				}

				const imageBlocks = imageBlocksFromAttachments(r.attachments);
				const content: (TextContent | ImageContent)[] = [{ type: "text", text: text || "" }, ...imageBlocks];

				return {
					content,
					details: {
						durationMs: r.durationMs,
						status: r.status,
						errorEname: r.error?.ename,
						stdout: r.stdout,
						stderr: r.stderr,
						result: r.result,
						backgroundOutput: r.backgroundOutput,
						diffs: r.diffs,
						attachments: r.attachments,
						sentAgentMessages: r.sentAgentMessages,
						kernelRestarted,
						error: r.error,
					},
					isError: r.status === "error" || r.status === "aborted",
				};
			} finally {
				if (hasWorkingMessage) {
					setToolWorkingMessage();
				}
			}
		},
	};
}

export function createIScriptTool(cwd: string, options?: IScriptToolOptions): AgentTool<typeof iscriptSchema> {
	return wrapToolDefinition(createIScriptToolDefinition(cwd, options));
}

export const createIpythonToolDefinition = createIScriptToolDefinition;
export const createIpythonTool = createIScriptTool;
