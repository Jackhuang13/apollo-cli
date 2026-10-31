import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readdirSync, readFileSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const IS_POSIX = process.platform !== "win32";
const HEAD_CAP = 512 * 1024;
const TAIL_CAP = 3 * 512 * 1024;
const COMPLETION_PREFIX = Buffer.from("\x1eprime-agent-complete:");
const COMPLETION_SUFFIX = Buffer.from("\x1f");
const CANCEL_TERM_GRACE_MS = 500;
const CANCEL_KILL_WAIT_MS = 2000;
const COMPLETION_NOTICE_COMMAND_CAP = 1000;

function cappedCommand(command: string): string {
	if (command.length > COMPLETION_NOTICE_COMMAND_CAP) {
		return `${command.slice(0, COMPLETION_NOTICE_COMMAND_CAP)}\n... [command truncated]`;
	}
	return command;
}
export const DEFAULT_BASH_TIMEOUT_SECONDS = 600;

export const BASH_ACTIVITY_MIME = "application/vnd.apollo-cli.bash-activity+json";
export const LEGACY_BASH_ACTIVITY_MIME = "application/vnd.prime-agent.bash-activity+json";

export class BashResult {
	readonly exit_code: number;
	readonly exitCode: number;
	readonly output: string;
	readonly duration: number;

	constructor(exitCode: number, output: string, duration: number) {
		this.exit_code = exitCode;
		this.exitCode = exitCode;
		this.output = output;
		this.duration = duration;
	}
}

export interface BashOptions {
	timeout?: number | null;
}

interface ReplBridgeHooks {
	isActive: () => boolean;
	emit: (data: Record<string, unknown>) => void;
	hostRequest: (data: Record<string, unknown>) => Promise<Record<string, unknown>>;
	sendRawEvent: (event: Record<string, unknown>) => void;
	currentCellCompletionBarrier: () => Promise<void> | null;
}

let replBridge: ReplBridgeHooks | null = null;

export function _registerReplBridge(hooks: ReplBridgeHooks): void {
	replBridge = hooks;
}

class BoundedBuffer {
	private head: Buffer[] = [];
	private headSize = 0;
	private tail: Buffer[] = [];
	private tailSize = 0;
	private dropped = 0;

	write(chunk: Buffer): void {
		if (chunk.length === 0) return;
		if (this.headSize < HEAD_CAP) {
			const take = Math.min(chunk.length, HEAD_CAP - this.headSize);
			this.head.push(chunk.subarray(0, take));
			this.headSize += take;
			chunk = chunk.subarray(take);
		}
		if (chunk.length === 0) return;
		this.tail.push(chunk);
		this.tailSize += chunk.length;
		while (this.tailSize > TAIL_CAP && this.tail.length > 0) {
			const excess = this.tailSize - TAIL_CAP;
			const oldest = this.tail[0]!;
			if (oldest.length <= excess) {
				this.tail.shift();
				this.tailSize -= oldest.length;
				this.dropped += oldest.length;
			} else {
				this.tail[0] = oldest.subarray(excess);
				this.tailSize -= excess;
				this.dropped += excess;
			}
		}
	}

	size(): number {
		return this.headSize + this.tailSize;
	}

	text(): string {
		const headBuf = Buffer.concat(this.head);
		const tailBuf = Buffer.concat(this.tail);
		if (this.dropped === 0) {
			return Buffer.concat([headBuf, tailBuf]).toString("utf-8");
		}
		const marker = `\n... [${this.dropped} bytes dropped] ...\n`;
		return headBuf.toString("utf-8") + marker + tailBuf.toString("utf-8");
	}
}

const liveHandles = new Set<BashHandle>();
let shutdownHookInstalled = false;

function installShutdownHook(): void {
	if (shutdownHookInstalled) return;
	shutdownHookInstalled = true;
	process.on("exit", () => {
		_kill_live_handles();
	});
}

function resolveShell(): string {
	const override = process.env.APOLLO_BASH_SHELL || process.env.PRIME_AGENT_BASH_SHELL;
	if (override) {
		if (!path.isAbsolute(override)) {
			throw new Error("APOLLO_BASH_SHELL / PRIME_AGENT_BASH_SHELL must be an absolute path");
		}
		return override;
	}
	if (!IS_POSIX) {
		throw new Error(
			"bash() needs APOLLO_BASH_SHELL or PRIME_AGENT_BASH_SHELL set to the absolute path of a POSIX shell on Windows",
		);
	}
	const pathDirs = (process.env.PATH || "/usr/local/bin:/usr/bin:/bin").split(path.delimiter);
	for (const dir of pathDirs) {
		if (!dir) continue;
		const candidate = path.join(dir, "bash");
		try {
			const stat = readFileSync(candidate, { flag: "r" });
			if (stat) return candidate;
		} catch {
			// continue
		}
	}
	return "/bin/bash";
}

function withPrefix(command: string): string {
	const prefix = process.env.APOLLO_BASH_COMMAND_PREFIX || process.env.PRIME_AGENT_BASH_COMMAND_PREFIX;
	return prefix ? `${prefix}\n${command}` : command;
}

function childEnv(): NodeJS.ProcessEnv {
	return {
		...process.env,
		APOLLO_SESSION_KERNEL_PID: String(process.pid),
		NO_COLOR: "1",
		TERM: "dumb",
		CLICOLOR: "0",
		FORCE_COLOR: "0",
		GIT_EDITOR: "true",
		GIT_SEQUENCE_EDITOR: "true",
		GIT_TERMINAL_PROMPTS: "0",
		GIT_ASKPASS: "true",
		SSH_ASKPASS_REQUIRE: "never",
		EDITOR: "true",
		VISUAL: "true",
		PAGER: "cat",
		GIT_PAGER: "cat",
		DEBIAN_FRONTEND: "noninteractive",
	};
}

function signalGroup(pid: number, sig: NodeJS.Signals | number): boolean {
	if (pid <= 0) return true;
	try {
		process.kill(-pid, sig);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ESRCH") {
			try {
				process.kill(pid, sig);
				return true;
			} catch (innerErr) {
				if ((innerErr as NodeJS.ErrnoException).code === "ESRCH") {
					return true;
				}
				return false;
			}
		}
		return false;
	}
}

function groupAlive(pid: number): boolean {
	if (pid <= 0) return false;
	if (!IS_POSIX) {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}
	try {
		process.kill(-pid, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EPERM") return true;
		try {
			process.kill(pid, 0);
			return true;
		} catch (innerErr) {
			return (innerErr as NodeJS.ErrnoException).code === "EPERM";
		}
	}
}

function processStartId(pid: number): string | null {
	if (process.platform === "win32") {
		try {
			const systemRoot = process.env.SystemRoot || "C:\\Windows";
			const psPath = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
			const res = spawnSync(
				psPath,
				[
					"-NoLogo",
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					`([System.Diagnostics.Process]::GetProcessById(${pid})).StartTime.ToUniversalTime().Ticks`,
				],
				{ encoding: "utf-8", timeout: 5000 },
			);
			const out = (res.stdout || "").trim();
			return /^\d+$/.test(out) ? `win:${out}` : null;
		} catch {
			return null;
		}
	}
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
		const rpar = stat.lastIndexOf(")");
		if (rpar !== -1) {
			const fields = stat.slice(rpar + 2).split(" ");
			if (fields.length > 19 && fields[19]) {
				return `proc:${fields[19]}`;
			}
		}
	} catch {
		// fallback to ps
	}
	try {
		const psCmd = process.platform === "darwin" ? "/bin/ps" : "ps";
		const res = spawnSync(psCmd, ["-p", String(pid), "-o", "lstart="], {
			encoding: "utf-8",
			timeout: 5000,
		});
		const out = (res.stdout || "").trim();
		return out ? `ps:${out}` : null;
	} catch {
		return null;
	}
}

function recordJournal(pid: number, active: boolean): boolean {
	const journalPath =
		process.env.APOLLO_INTERNAL_ORPHAN_PROCESS_JOURNAL ||
		process.env.PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL;
	const ownerRaw =
		process.env.APOLLO_KERNEL_OWNER_PID ||
		process.env.PRIME_AGENT_KERNEL_OWNER_PID;
	if (!journalPath || !ownerRaw) {
		return true;
	}
	const ownerPid = Number.parseInt(ownerRaw, 10);
	if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
		return false;
	}
	const startId = active ? processStartId(pid) : null;
	if (active && !startId) {
		return false;
	}
	const record: Record<string, unknown> = {
		version: 1,
		pid,
		ownerPid,
		kernelPid: process.pid,
		...(startId ? { processStartId: startId } : {}),
		active,
		recordedAt: new Date().toISOString(),
	};
	const data = Buffer.from(`${JSON.stringify(record)}\n`, "utf-8");
	try {
		const fd = openSync(journalPath, "a", 0o600);
		try {
			let offset = 0;
			while (offset < data.length) {
				const written = writeSync(fd, data, offset);
				if (written <= 0) return false;
				offset += written;
			}
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		return true;
	} catch {
		return false;
	}
}

export class BashHandle implements PromiseLike<BashResult> {
	readonly command: string;
	private readonly _pid: number;
	private readonly _buffer = new BoundedBuffer();
	private readonly _started = performance.now();
	private _released = false;
	private _reaped = false;
	private _done = false;
	private _result: BashResult | null = null;
	private _awaitedByCreatingCell = false;
	private _resultConsumed = false;
	private _consumedNotice: (() => void) | null = null;
	private _doneWaiters: Array<(res: BashResult) => void> = [];
	private _reapWaiters: Array<() => void> = [];
	private _timeoutTimer: ReturnType<typeof setTimeout> | null = null;
	private _forceKillTimer: ReturnType<typeof setTimeout> | null = null;
	/** Timeout duration in milliseconds scheduled for this handle, or null if indefinite. */
	readonly scheduledTimeoutMs: number | null = null;

	constructor(command: string, options?: BashOptions) {
		this.command = command;
		const script = withPrefix(command);
		const shell = resolveShell();
		const child = spawn(shell, ["-c", script], {
			cwd: process.cwd(),
			env: childEnv(),
			detached: IS_POSIX,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const pid = child.pid;
		if (pid === undefined) {
			throw new Error("bash(): failed to spawn child process");
		}
		this._pid = pid;
		liveHandles.add(this);

		if (!recordJournal(this._pid, true)) {
			this._abortSpawn();
			throw new Error(
				"bash(): orphan-journal enrollment failed (journal configured but the pid could not be recorded); the spawned process was killed",
			);
		}

		// Timeout resolution: options.timeout is strictly in seconds.
		// undefined -> default 600s.
		// null or 0 -> no timeout (indefinite).
		// positive finite number -> seconds * 1000 ms.
		const effectiveTimeoutSec =
			options?.timeout === undefined
				? DEFAULT_BASH_TIMEOUT_SECONDS
				: typeof options.timeout === "number" && Number.isFinite(options.timeout) && options.timeout > 0
					? options.timeout
					: null;

		if (effectiveTimeoutSec !== null) {
			const timeoutMs = Math.round(effectiveTimeoutSec * 1000);
			this.scheduledTimeoutMs = timeoutMs;
			this._timeoutTimer = setTimeout(() => {
				if (!this._done) {
					this.kill(0.5);
				}
			}, timeoutMs);
			this._timeoutTimer.unref?.();
		} else {
			this.scheduledTimeoutMs = null;
		}

		let stdoutEnded = false;
		let stderrEnded = false;
		let exitCode: number | null = null;

		const maybeFinalize = () => {
			if (exitCode !== null && stdoutEnded && stderrEnded) {
				this._finalize(exitCode);
			}
		};

		child.stdout?.on("data", (chunk: Buffer) => {
			this._buffer.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			this._buffer.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});

		child.stdout?.on("close", () => {
			stdoutEnded = true;
			maybeFinalize();
		});
		child.stderr?.on("close", () => {
			stderrEnded = true;
			maybeFinalize();
		});

		child.on("error", () => {
			if (exitCode === null) exitCode = 127;
			stdoutEnded = true;
			stderrEnded = true;
			maybeFinalize();
			this._onReap();
		});

		child.on("exit", (code, signal) => {
			exitCode = code !== null ? code : signal ? 128 : 1;
			// Wait a short grace period if streams are still open from background jobs
			const graceTimer = setTimeout(() => {
				stdoutEnded = true;
				stderrEnded = true;
				maybeFinalize();
				this._onReap();
			}, 100);
			graceTimer.unref?.();
		});

		child.on("close", (code, signal) => {
			if (exitCode === null) {
				exitCode = code !== null ? code : signal ? 128 : 1;
			}
			stdoutEnded = true;
			stderrEnded = true;
			maybeFinalize();
			this._onReap();
		});

		this._scheduleBackgroundCompletionNotice();
	}

	get pid(): number {
		this._released = true;
		return this._pid;
	}

	get running(): boolean {
		this._released = true;
		return !this._reaped;
	}

	output(): string {
		this._released = true;
		this._noteResultConsumed();
		return this._buffer.text();
	}

	tail(n = 50): string {
		this._released = true;
		this._noteResultConsumed();
		const lines = this._buffer.text().split(/\r?\n/);
		if (lines.length > 0 && lines[lines.length - 1] === "") {
			lines.pop();
		}
		return lines.slice(-n).join("\n");
	}

	poll(): BashResult | null {
		this._released = true;
		this._noteResultConsumed();
		return this._done ? this._result : null;
	}

	/**
	 * Returns all live descendant processes spawned under this bash handle
	 * (excluding the current session kernel PID to prevent accidental termination).
	 */
	descendants(): Array<{ pid: number; ppid: number; comm?: string; state?: string }> {
		this._released = true;
		if (this._reaped || this._pid <= 0) return [];
		const rootPid = this._pid;
		const parentMap = new Map<number, number>();
		const commMap = new Map<number, string>();
		const stateMap = new Map<number, string>();

		if (IS_POSIX) {
			try {
				const entries = readdirSync("/proc");
				for (const entry of entries) {
					if (!/^\d+$/.test(entry)) continue;
					const pid = Number.parseInt(entry, 10);
					if (pid === process.pid) continue; // Safety guard: ignore current kernel process
					try {
						const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
						// Match after the last closing parenthesis to prevent comm with spaces/parens from throwing off field indices
						const rpar = stat.lastIndexOf(")");
						if (rpar !== -1) {
							const comm = stat.slice(stat.indexOf("(") + 1, rpar);
							const fields = stat.slice(rpar + 2).split(" ");
							const state = fields[0];
							const ppid = Number.parseInt(fields[1] || "", 10);
							if (Number.isFinite(ppid)) {
								parentMap.set(pid, ppid);
								commMap.set(pid, comm);
								if (state) stateMap.set(pid, state);
							}
						}
					} catch {
						// Process may have exited
					}
				}
			} catch {
				// /proc not mounted or inaccessible
			}
		}

		const queue = [rootPid];
		const descendants: Array<{ pid: number; ppid: number; comm?: string; state?: string }> = [];
		const visited = new Set<number>([rootPid]);

		while (queue.length > 0) {
			const curr = queue.shift()!;
			for (const [pid, ppid] of parentMap.entries()) {
				if (ppid === curr && !visited.has(pid)) {
					visited.add(pid);
					descendants.push({
						pid,
						ppid,
						comm: commMap.get(pid),
						state: stateMap.get(pid),
					});
					queue.push(pid);
				}
			}
		}
		return descendants;
	}

	kill(gracePeriod = 5.0): void {
		this._released = true;
		if (this._reaped) return;
		if (!IS_POSIX) {
			try {
				process.kill(this._pid, "SIGTERM");
			} catch {
				// ignore
			}
			return;
		}
		signalGroup(this._pid, "SIGTERM");
		if (this._forceKillTimer) clearTimeout(this._forceKillTimer);
		this._forceKillTimer = setTimeout(() => {
			if (!this._reaped) {
				signalGroup(this._pid, "SIGKILL");
			}
		}, Math.max(0, gracePeriod * 1000));
		this._forceKillTimer.unref?.();
	}

	private _abortSpawn(): void {
		if (IS_POSIX) {
			signalGroup(this._pid, "SIGKILL");
		} else {
			try {
				process.kill(this._pid, "SIGKILL");
			} catch {
				// ignore
			}
		}
		this._reaped = true;
		liveHandles.delete(this);
		recordJournal(this._pid, false);
	}

	private _finalize(code: number): void {
		if (this._done) return;
		if (this._timeoutTimer) {
			clearTimeout(this._timeoutTimer);
			this._timeoutTimer = null;
		}
		const duration = (performance.now() - this._started) / 1000;
		const output = this._buffer.text();
		this._result = {
			exit_code: code,
			exitCode: code,
			output,
			duration,
		};
		this._done = true;
		const waiters = this._doneWaiters.splice(0);
		for (const waiter of waiters) {
			waiter(this._result);
		}
	}

	private _onReap(): void {
		if (this._reaped) return;
		if (this._forceKillTimer) {
			clearTimeout(this._forceKillTimer);
			this._forceKillTimer = null;
		}
		if (IS_POSIX) {
			signalGroup(this._pid, "SIGKILL");
		}
		this._reaped = true;
		recordJournal(this._pid, false);
		liveHandles.delete(this);
		const waiters = this._reapWaiters.splice(0);
		for (const waiter of waiters) {
			waiter();
		}
	}

	private _wait(): Promise<BashResult> {
		if (this._done && this._result) {
			return Promise.resolve(this._result);
		}
		return new Promise<BashResult>((resolve) => {
			this._doneWaiters.push(resolve);
		});
	}

	private _waitReaped(): Promise<void> {
		if (this._reaped) return Promise.resolve();
		return new Promise<void>((resolve) => {
			this._reapWaiters.push(resolve);
		});
	}

	private _noteResultConsumed(): void {
		if (!this._done) return;
		if (this._resultConsumed) return;
		this._resultConsumed = true;
		const notice = this._consumedNotice;
		this._consumedNotice = null;
		if (notice) notice();
	}

	private _scheduleBackgroundCompletionNotice(): void {
		if (!replBridge || !replBridge.isActive()) return;
		const cellBarrier = replBridge.currentCellCompletionBarrier();
		if (!cellBarrier) return;
		const activityId = randomBytes(16).toString("hex");
		const activity = {
			id: activityId,
			pid: this._pid,
			active: true,
			command: cappedCommand(this.command),
			timeoutMs: this.scheduledTimeoutMs,
			background: false,
		};
		// Independent of the completion path on purpose: it must not delay the
		// inactive event (short tasks that finish before the cell ends), and it
		// only marks the handle background when the creating cell ends first.
		void (async () => {
			try {
				await cellBarrier;
				if (
					!this._reaped &&
					!this._awaitedByCreatingCell &&
					!this._resultConsumed &&
					replBridge?.isActive()
				) {
					const backgrounded = { ...activity, background: true };
					replBridge.emit({
						[BASH_ACTIVITY_MIME]: backgrounded,
						[LEGACY_BASH_ACTIVITY_MIME]: backgrounded,
					});
				}
			} catch {
				// Standalone or closed bridge
			}
		})();
		replBridge.emit({
			[BASH_ACTIVITY_MIME]: activity,
			[LEGACY_BASH_ACTIVITY_MIME]: activity,
		});

		void (async () => {
			try {
				const result = await this._wait();
				await this._waitReaped();
				await cellBarrier;
				if (this._awaitedByCreatingCell || this._resultConsumed || !replBridge?.isActive()) {
					return;
				}
				const command = cappedCommand(this.command);
				const reply = await replBridge.hostRequest({
					type: "bash.completed",
					pid: this._pid,
					command,
					exitCode: result.exit_code,
				});
				if (reply && reply.status === "ok") {
					this._armConsumedNotice(command);
				} else {
					process.stderr.write(
						`Background bash completion follow-up for pid ${this._pid} was not accepted. Inspect the saved handle with poll(), output(), or tail().\n`,
					);
				}
			} catch {
				// Standalone or closed bridge
			} finally {
				if (replBridge?.isActive()) {
					const inactive = { ...activity, active: false };
					replBridge.emit({
						[BASH_ACTIVITY_MIME]: inactive,
						[LEGACY_BASH_ACTIVITY_MIME]: inactive,
					});
				}
			}
		})();
	}

	private _armConsumedNotice(command: string): void {
		const dispatch = () => {
			if (!replBridge?.isActive()) return;
			replBridge.sendRawEvent({
				event: "host_request",
				id: randomUUID().replaceAll("-", ""),
				data: { type: "bash.consumed", pid: this._pid, command },
			});
		};
		if (!this._resultConsumed) {
			this._consumedNotice = dispatch;
			return;
		}
		dispatch();
	}

	// biome-ignore lint/suspicious/noThenProperty: BashHandle is an intentional PromiseLike<BashResult>
	then<TResult1 = BashResult, TResult2 = never>(
		onfulfilled?: ((value: BashResult) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
	): Promise<TResult1 | TResult2> {
		const owned = !this._released;
		this._released = true;
		if (owned) {
			this._awaitedByCreatingCell = true;
		}
		return this._wait().then(
			(res) => {
				this._awaitedByCreatingCell = true;
				this._noteResultConsumed();
				return onfulfilled ? onfulfilled(res) : (res as unknown as TResult1);
			},
			onrejected,
		);
	}

	toString(): string {
		const state = this._result ? `exit_code=${this._result.exit_code}` : "running";
		return `<BashHandle pid=${this._pid} ${state} command=${JSON.stringify(this.command)}>`;
	}
}

export function bash(command: string, options?: BashOptions): BashHandle {
	if (typeof command !== "string" || !command) {
		throw new TypeError("command must be a non-empty string");
	}
	installShutdownHook();
	return new BashHandle(command, options);
}

export function _kill_live_handles(): void {
	const handles = [...liveHandles];
	for (const handle of handles) {
		const pid = handle.pid;
		let delivered = false;
		if (IS_POSIX) {
			delivered = signalGroup(pid, "SIGKILL");
		} else {
			try {
				process.kill(pid, "SIGKILL");
				delivered = true;
			} catch {
				delivered = false;
			}
		}
		if (delivered) {
			recordJournal(pid, false);
		}
	}
	liveHandles.clear();
}
