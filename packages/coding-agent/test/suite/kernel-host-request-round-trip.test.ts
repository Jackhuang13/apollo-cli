import { type ChildProcessWithoutNullStreams, spawn as spawnChild } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReplKernelManager } from "../../src/core/kernel/index.js";
import { buildIScriptBootstrapCode, PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER } from "../../src/core/tools/iscript.js";
import { resolveKernelBashShell } from "../../src/utils/shell.js";

type Frame = Record<string, unknown>;

const RUNTIME_PATH_CANDIDATES = [
	resolve(process.cwd(), "../../apollo-cli-runtime/src/rlm/mod.ts"),
	resolve(__dirname, "../../../apollo-cli-runtime/src/rlm/mod.ts"),
];
const RUNTIME_PATH = RUNTIME_PATH_CANDIDATES.find((candidate) => existsSync(candidate));

/**
 * Drives the real TS runtime as a child process and acts as the host: writes
 * NDJSON protocol frames to its stdin and answers the `host_request` frames it
 * emits with `host_reply` frames.
 */
class RuntimeHost {
	child: ChildProcessWithoutNullStreams | undefined;
	private buffer = "";
	private frames: Frame[] = [];
	private waiters: Array<{
		predicate: (frame: Frame) => boolean;
		resolve: (frame: Frame) => void;
		reject: (err: Error) => void;
	}> = [];

	start(timeoutMs = 15000, extraEnv: NodeJS.ProcessEnv = {}): Promise<void> {
		return new Promise((resolveStart, rejectStart) => {
			if (!RUNTIME_PATH) {
				rejectStart(
					new Error(`apollo-cli-runtime/src/rlm/mod.ts not found: ${RUNTIME_PATH_CANDIDATES.join(", ")}`),
				);
				return;
			}
			const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
			const shell = resolveKernelBashShell();
			if (shell) env.PRIME_AGENT_BASH_SHELL = shell;
			const child = spawnChild(process.execPath, ["--experimental-strip-types", RUNTIME_PATH], {
				env,
				stdio: ["pipe", "pipe", "pipe"],
			});
			this.child = child;
			let settled = false;
			const settleReady = (): void => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					resolveStart();
				}
			};
			// test-policy: allow wall-clock-timer -- bounds a real subprocess ready handshake; the timer only fails, the ready frame resolves
			const timer = setTimeout(() => {
				if (!settled) {
					settled = true;
					rejectStart(new Error("runtime did not emit ready within the startup window"));
				}
			}, timeoutMs);
			child.stdout.on("data", (chunk: Buffer) => {
				this.buffer += chunk.toString("utf8");
				let newline = this.buffer.indexOf("\n");
				while (newline >= 0) {
					const line = this.buffer.slice(0, newline).trim();
					this.buffer = this.buffer.slice(newline + 1);
					if (line) {
						let frame: Frame | undefined;
						try {
							frame = JSON.parse(line) as Frame;
						} catch {
							frame = undefined;
						}
						if (frame) {
							this.pushFrame(frame);
							if (frame.event === "ready") settleReady();
						}
					}
					newline = this.buffer.indexOf("\n");
				}
			});
			child.stderr.on("data", () => undefined);
			child.on("error", (err) => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					rejectStart(err);
				}
			});
		});
	}

	private pushFrame(frame: Frame): void {
		const pendingWaiters = this.waiters.filter((waiter) => waiter.predicate(frame));
		if (pendingWaiters.length === 0) {
			this.frames.push(frame);
			return;
		}
		for (const waiter of pendingWaiters) {
			this.waiters.splice(this.waiters.indexOf(waiter), 1);
			waiter.resolve(frame);
		}
	}

	/** Wait for a frame matching the predicate; earlier unmatched frames are buffered. */
	waitFrame(predicate: (frame: Frame) => boolean, timeoutMs = 20000): Promise<Frame> {
		const buffered = this.frames.findIndex(predicate);
		if (buffered >= 0) {
			const [frame] = this.frames.splice(buffered, 1);
			return Promise.resolve(frame);
		}
		return new Promise<Frame>((resolveWait, rejectWait) => {
			// test-policy: allow wall-clock-timer -- bounds waiting on a real kernel frame; a matching frame resolves, the timer only fails
			const timer = setTimeout(() => {
				rejectWait(new Error(`timed out waiting for frame; buffered=${JSON.stringify(this.frames)}`));
			}, timeoutMs);
			this.waiters.push({
				predicate: (frame) => {
					clearTimeout(timer);
					return predicate(frame);
				},
				resolve: (frame) => resolveWait(frame),
				reject: (err) => rejectWait(err),
			});
		});
	}

	send(frame: Frame): void {
		this.child?.stdin.write(`${JSON.stringify(frame)}\n`);
	}

	replyToHostRequest(id: string, data: Frame): void {
		this.send({ type: "host_reply", id, data });
	}

	closeStdin(): void {
		this.child?.stdin.end();
	}

	async exit(timeoutMs = 10000): Promise<number> {
		const child = this.child;
		if (!child) return -1;
		return new Promise((resolveExit) => {
			if (child.exitCode !== null) {
				resolveExit(child.exitCode);
				return;
			}
			// test-policy: allow wall-clock-timer -- bounds a real subprocess teardown; the exit event resolves, the timer only force-kills
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				resolveExit(-1);
			}, timeoutMs);
			child.on("exit", (code) => {
				clearTimeout(timer);
				resolveExit(code ?? -1);
			});
		});
	}

	dispose(): void {
		if (this.child && this.child.exitCode === null) {
			this.child.kill("SIGKILL");
		}
	}
}

describe("host_request round-trip (real TS runtime, scripted host)", () => {
	const host = new RuntimeHost();

	beforeAll(async () => {
		await host.start();
	});

	afterAll(async () => {
		try {
			host.send({ type: "shutdown" });
			await host.exit();
		} finally {
			host.dispose();
		}
	});

	it("emits the host_request frame shape and unwraps an ok reply", async () => {
		host.send({
			type: "execute",
			id: "rt-ok",
			code: 'const r = await host_request("test.op", { echo: "x" }); r.value',
		});
		const frame = await host.waitFrame((candidate) => candidate.event === "host_request");
		const requestId = String(frame.id ?? "");
		expect(requestId).not.toBe("rt-ok");
		expect(requestId.length).toBeGreaterThan(0);
		expect(frame).not.toHaveProperty("request_id");
		expect(frame).not.toHaveProperty("payload");
		expect(frame.data).toMatchObject({ type: "test.op", echo: "x" });
		host.replyToHostRequest(requestId, { status: "ok", result: { value: 42 } });
		const result = await host.waitFrame((candidate) => candidate.event === "result" && candidate.id === "rt-ok");
		expect(result.text).toBe("42");
		await host.waitFrame((candidate) => candidate.event === "done" && candidate.id === "rt-ok");
	});

	it("places type last so a payload type key cannot reroute the request", async () => {
		host.send({
			type: "execute",
			id: "rt-reroute",
			code: 'await host_request("outer.type", { type: "inner.type" }); "ok"',
		});
		const frame = await host.waitFrame((candidate) => candidate.event === "host_request");
		expect((frame.data as Frame).type).toBe("outer.type");
		host.replyToHostRequest(String(frame.id ?? ""), { status: "ok", result: {} });
		const done = await host.waitFrame((candidate) => candidate.event === "done" && candidate.id === "rt-reroute");
		expect(done.status).toBe("ok");
	});

	it("rejects with the host error text on a status: error reply", async () => {
		host.send({ type: "execute", id: "rt-err", code: 'await host_request("test.fail")' });
		const frame = await host.waitFrame((candidate) => candidate.event === "host_request");
		host.replyToHostRequest(String(frame.id ?? ""), { status: "error", error: "boom from host" });
		const error = await host.waitFrame((candidate) => candidate.event === "error" && candidate.id === "rt-err");
		expect(String(error.evalue)).toContain("boom from host");
		const done = await host.waitFrame((candidate) => candidate.event === "done" && candidate.id === "rt-err");
		expect(done.status).toBe("error");
	});

	it("rejects after the configured timeout when the host never replies", async () => {
		host.send({ type: "execute", id: "rt-timeout", code: 'await host_request("test.slow", undefined, 0.5)' });
		await host.waitFrame((candidate) => candidate.event === "host_request");
		const error = await host.waitFrame((candidate) => candidate.event === "error" && candidate.id === "rt-timeout");
		expect(String(error.evalue)).toMatch(/timed out after 0\.5s/);
		const done = await host.waitFrame((candidate) => candidate.event === "done" && candidate.id === "rt-timeout");
		expect(done.status).toBe("error");
	});

	it("arms the consumed notice when bash.completed gets a status: ok reply", async () => {
		host.send({ type: "execute", id: "rt-bash", code: 'globalThis.__rt_handle = bash("true"); "created"' });
		await host.waitFrame((candidate) => candidate.event === "done" && candidate.id === "rt-bash");
		const completed = await host.waitFrame(
			(candidate) => candidate.event === "host_request" && (candidate.data as Frame).type === "bash.completed",
		);
		host.replyToHostRequest(String(completed.id ?? ""), { status: "ok", result: {} });
		host.send({ type: "execute", id: "rt-bash-consume", code: "globalThis.__rt_handle.output(); 'consumed'" });
		const consumed = await host.waitFrame(
			(candidate) => candidate.event === "host_request" && (candidate.data as Frame).type === "bash.consumed",
		);
		expect(consumed.data).toMatchObject({ type: "bash.consumed" });
		await host.waitFrame((candidate) => candidate.event === "done" && candidate.id === "rt-bash-consume");
	});

	it("closes host stdin rejects every pending host request", async () => {
		host.send({
			type: "execute",
			id: "rt-close",
			code: 'await host_request("test.noreply", undefined, 300); "unreachable"',
		});
		await host.waitFrame((candidate) => candidate.event === "host_request");
		host.closeStdin();
		const error = await host.waitFrame((candidate) => candidate.event === "error" && candidate.id === "rt-close");
		expect(String(error.evalue)).toContain("host connection closed");
		const code = await host.exit();
		expect(code).toBe(0);
	});
});

describe("interpreter bootstrap dialects (AC-14, AC-15, AC-20, AC-21)", () => {
	const skillsDir = resolve(process.cwd(), "skills");
	const pythonRuntimeSrc = resolve(process.cwd(), "../../prime-agent-runtime/src");
	const probeSkill = {
		name: "probe-skill",
		importName: "no_such_skill_apollo_probe",
		packagePath: join(skillsDir, "probe-skill"),
		pyprojectPath: join(skillsDir, "probe-skill", "pyproject.toml"),
	};

	it("TS kernel: bootstrap unwraps the ESM default export and named imports keep working", async () => {
		const host = new RuntimeHost();
		try {
			await host.start(15000, { APOLLO_SKILLS_DIR: skillsDir });
			const bootstrap = buildIScriptBootstrapCode([
				{
					name: "edit",
					importName: "edit",
					packagePath: join(skillsDir, "edit"),
					pyprojectPath: join(skillsDir, "edit", "pyproject.toml"),
				},
			]);
			host.send({ type: "execute", id: "sk-boot", code: bootstrap });
			const boot = await host.waitFrame((f) => f.event === "done" && f.id === "sk-boot");
			expect(boot.status).toBe("ok");

			host.send({
				type: "execute",
				id: "sk-bare",
				code: `
					const t = typeof globalThis.edit;
					let found = false;
					try {
						await globalThis.edit("/nonexistent-apollo-probe.ts", "x", "y");
					} catch (err) {
						found = String(err).includes("File not found");
					}
					JSON.stringify({ t, found });
				`,
			});
			const bare = await host.waitFrame((f) => f.event === "result" && f.id === "sk-bare");
			// util.inspect string repr: single-quoted
			expect(bare.text).toBe(`'${JSON.stringify({ t: "function", found: true })}'`);
			await host.waitFrame((f) => f.event === "done" && f.id === "sk-bare");

			host.send({
				type: "execute",
				id: "sk-named",
				code: `
					import { EditError } from "edit";
					new EditError("probe").constructor.name;
				`,
			});
			const named = await host.waitFrame((f) => f.event === "result" && f.id === "sk-named");
			expect(named.text).toBe(`'EditError'`);
			await host.waitFrame((f) => f.event === "done" && f.id === "sk-named");
		} finally {
			host.send({ type: "shutdown" });
			await host.exit();
			host.dispose();
		}
	});

	it("Python fallback kernel from an external cwd runs the Python bootstrap without a JS SyntaxError", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "apollo-py-kernel-"));
		const previousCwd = process.cwd();
		process.chdir(tempDir);
		let manager: ReplKernelManager | undefined;
		try {
			manager = new ReplKernelManager({
				python: "python3",
				cwd: tempDir,
				env: { ...process.env, PYTHONPATH: pythonRuntimeSrc } as Record<string, string>,
				pythonSkills: [probeSkill],
			});
			expect(manager.interpreter).toBe("script"); // constructor default before doStart
			await manager.start();
			// No apollo-cli-runtime under this cwd: the manager fell back to python.
			expect(manager.interpreter).toBe("python");
			expect(manager.buildBootstrapCode()).toContain("import rlm as _bootstrap_rlm");

			const bootstrap = await manager.execute(manager.buildBootstrapCode());
			expect(bootstrap.status).toBe("ok");
			expect(bootstrap.stdout).toContain(PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER);

			const firstCell = await manager.execute("print('first-cell', 1 + 1)");
			expect(firstCell.status).toBe("ok");
			expect(firstCell.stdout).toContain("first-cell 2");

			const missing = await manager.execute("no_such_skill_apollo_probe.foo");
			expect(missing.status).toBe("error");
			expect(missing.error?.ename).toBe("AttributeError");
			expect(missing.error?.evalue).toContain("unavailable in this kernel");
		} finally {
			process.chdir(previousCwd);
			try {
				await manager?.kill();
			} finally {
				manager?.disposeSync();
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});

	it("ReplKernelManager.buildBootstrapCode honors an explicit bootstrapCode override", () => {
		const manager = new ReplKernelManager({ python: "python3", cwd: "/tmp" });
		expect(manager.buildBootstrapCode()).toContain("NO_COLOR");
		const overridden = new ReplKernelManager({ python: "python3", cwd: "/tmp", bootstrapCode: "boot-code" });
		expect(overridden.buildBootstrapCode()).toBe("boot-code");
		manager.disposeSync();
		overridden.disposeSync();
	});
});
