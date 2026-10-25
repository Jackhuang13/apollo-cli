import { type ChildProcessWithoutNullStreams, spawn as spawnChild } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	ensureKernelPython,
	resolveRuntimeSourceDir,
	tsRuntimeCandidateDirs,
} from "../../src/core/kernel/bootstrap.js";
import { ReplKernelManager } from "../../src/core/kernel/index.js";

vi.mock("../../src/core/kernel/bootstrap.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../src/core/kernel/bootstrap.js")>();
	return {
		...original,
		ensureKernelPython: vi.fn().mockRejectedValue(new Error("TS kernel must not trigger Python provisioning")),
		tsRuntimeCandidateDirs: vi.fn(original.tsRuntimeCandidateDirs),
	};
});

import { buildIScriptBootstrapCode } from "../../src/core/tools/iscript.js";
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

	it("rlm.progress_note issues rlm.progress.note with {message} and returns the throttle result", async () => {
		host.send({
			type: "execute",
			id: "rt-prog",
			code: 'const r = await rlm.progress_note("probe note"); JSON.stringify(r)',
		});
		const frame = await host.waitFrame(
			(candidate) => candidate.event === "host_request" && (candidate.data as Frame).type === "rlm.progress.note",
		);
		expect(frame.data).toMatchObject({ type: "rlm.progress.note", message: "probe note" });
		host.replyToHostRequest(String(frame.id ?? ""), {
			status: "ok",
			result: { accepted: false, retry_after_ms: 250 },
		});
		const result = await host.waitFrame((candidate) => candidate.event === "result" && candidate.id === "rt-prog");
		expect(result.text).toBe(`'${JSON.stringify({ accepted: false, retry_after_ms: 250 })}'`);
		await host.waitFrame((candidate) => candidate.event === "done" && candidate.id === "rt-prog");
	});

	it("closes host stdin rejects every pending host request", async () => {
		// Dedicated child: closing stdin exits the runtime, which would break tests
		// running after this one under shuffling.
		const closeHost = new RuntimeHost();
		await closeHost.start();
		try {
			closeHost.send({
				type: "execute",
				id: "rt-close",
				code: 'await host_request("test.noreply", undefined, 300); "unreachable"',
			});
			await closeHost.waitFrame((candidate) => candidate.event === "host_request");
			closeHost.closeStdin();
			const error = await closeHost.waitFrame(
				(candidate) => candidate.event === "error" && candidate.id === "rt-close",
			);
			expect(String(error.evalue)).toContain("host connection closed");
			expect(await closeHost.exit()).toBe(0);
		} finally {
			closeHost.dispose();
		}
	});
});

describe("rlm.* client wire shapes (AC-07, AC-08, AC-09)", () => {
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

	it.each<[string, string, Frame, Frame]>([
		[
			"spawn",
			'const r = await rlm.spawn({ prompt: "do it", name: "w1", model: "m1", thinking_level: "low" }); JSON.stringify(r)',
			{ type: "rlm.run", prompt: "do it", kwargs: { name: "w1", model: "m1", thinking: "low" } },
			{ rlm_child_id: "c1", name: "w1" },
		],
		[
			"create_session",
			'const r = await rlm.create_session({ prompt: "s", name: "s1", cwd: "/work" }); JSON.stringify(r)',
			{ type: "rlm.create_session", prompt: "s", kwargs: { name: "s1", cwd: "/work" } },
			{ active_session_id: "as1", name: "s1" },
		],
		[
			"find_models",
			'const r = await rlm.find_models("gpt", 3); JSON.stringify(r)',
			{ type: "rlm.find_models", query: "gpt", limit: 3 },
			{ models: ["m1", "m2"] },
		],
		[
			"list_subagents",
			"const r = await rlm.list_subagents(); JSON.stringify(r)",
			{ type: "rlm.list_subagents" },
			{ subagents: [{ id: "a1" }] },
		],
		[
			"collect",
			'const r = await rlm.collect(["w1"], { timeout_ms: 1000 }); JSON.stringify(r)',
			{ type: "rlm.collect", targets: ["w1"], timeout_ms: 1000 },
			{ results: [{ id: "w1", status: "done" }] },
		],
		[
			"delete_subagent",
			'const r = await rlm.delete_subagent("w1"); JSON.stringify(r)',
			{ type: "rlm.delete_subagent", target: "w1" },
			{ deleted: true },
		],
	])("rlm.%s issues its wire op and payload, then unwraps the reply", async (label, code, payload, replyResult) => {
		const id = `rt-wire-${label}`;
		host.send({ type: "execute", id, code });
		const frame = await host.waitFrame(
			(candidate) => candidate.event === "host_request" && (candidate.data as Frame).type === payload.type,
		);
		expect(frame.data).toEqual(payload);
		host.replyToHostRequest(String(frame.id ?? ""), { status: "ok", result: replyResult });
		const unwrap: Record<string, keyof Frame> = { "rlm.find_models": "models", "rlm.list_subagents": "subagents" };
		const key = unwrap[String(payload.type)];
		const returned = key === undefined ? replyResult : replyResult[key];
		const result = await host.waitFrame((candidate) => candidate.event === "result" && candidate.id === id);
		expect(result.text).toBe(`'${JSON.stringify(returned)}'`);
		await host.waitFrame((candidate) => candidate.event === "done" && candidate.id === id);
	});

	it("rlm.spawn rejects unsupported kwargs client-side without emitting a host_request", async () => {
		host.send({
			type: "execute",
			id: "rt-wire-reject",
			code: 'await rlm.spawn({ prompt: "do it", name: "w1", cwd: "/work" }).then(() => "spawned", (e) => String(e.message))',
		});
		const result = await host.waitFrame(
			(candidate) => candidate.event === "result" && candidate.id === "rt-wire-reject",
		);
		expect(String(result.text)).toContain("remove unsupported options: cwd");
		// No host_reply is sent: an emitted host_request would leave the cell awaiting the host, so done never arrives.
		const done = await host.waitFrame((candidate) => candidate.event === "done" && candidate.id === "rt-wire-reject");
		expect(done.status).toBe("ok");
	});
});

describe("interpreter bootstrap dialects (AC-14, AC-15, AC-20, AC-21)", () => {
	const skillsDir = resolve(process.cwd(), "skills");

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

	it("rejects startup when apollo-cli-runtime cannot be resolved", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "apollo-no-runtime-"));
		const previousCwd = process.cwd();
		vi.stubEnv("PI_PACKAGE_DIR", tempDir);
		process.chdir(tempDir);
		// The repo-root source candidate is always present in a checkout, so the
		// candidate source must be isolated to exercise the unresolvable path.
		vi.mocked(tsRuntimeCandidateDirs).mockImplementationOnce(() => [join(tempDir, "absent-runtime")]);
		let manager: ReplKernelManager | undefined;
		try {
			manager = new ReplKernelManager({
				cwd: tempDir,
			});
			await expect(manager.start()).rejects.toThrow("Could not resolve apollo-cli-runtime");
		} finally {
			process.chdir(previousCwd);
			vi.unstubAllEnvs();
			manager?.disposeSync();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("TS kernel: host injects APOLLO_SKILLS_DIR default from the agent dir (issue: skill path resolution)", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "apollo-skilldir-"));
		const skillSrc = join(tempDir, "skills", "w5skill", "src");
		mkdirSync(skillSrc, { recursive: true });
		writeFileSync(join(skillSrc, "mod.ts"), "export const v = 7;\n");
		vi.stubEnv("APOLLO_AGENT_DIR", tempDir);
		vi.stubEnv("APOLLO_SKILLS_DIR", "");
		let manager: ReplKernelManager | undefined;
		try {
			manager = new ReplKernelManager({ cwd: tempDir });
			await manager.start();
			const res = await manager.execute("(await __apollo_import__('w5skill')).v");
			expect(res.status).toBe("ok");
			expect(res.result).toBe("7");
		} finally {
			vi.unstubAllEnvs();
			manager?.disposeSync();
			rmSync(tempDir, { recursive: true, force: true });
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

describe("package-relative TS runtime resolution (AC-40, AC-41, AC-42)", () => {
	it("installed dist layout starts a TS kernel from a non-repo cwd without uv/venv work (AC-40, AC-41)", async () => {
		const packageDir = mkdtempSync(join(tmpdir(), "apollo-installed-pkg-"));
		const workCwd = mkdtempSync(join(tmpdir(), "apollo-installed-cwd-"));
		cpSync(resolve(RUNTIME_PATH!, "..", "..", ".."), join(packageDir, "dist", "apollo-cli-runtime"), {
			recursive: true,
		});
		const previousCwd = process.cwd();
		// No configured interpreter: the in-package TS runtime must be the default.
		vi.stubEnv("PI_PACKAGE_DIR", packageDir);
		vi.stubEnv("APOLLO_KERNEL_DENO", undefined);
		vi.stubEnv("PRIME_AGENT_KERNEL_PYTHON", undefined);
		process.chdir(workCwd);
		const ensureSpy = vi.mocked(ensureKernelPython);
		let manager: ReplKernelManager | undefined;
		try {
			manager = new ReplKernelManager({ cwd: workCwd });
			await manager.start();
			expect(manager.interpreter).toBe("script");
			expect(ensureSpy).not.toHaveBeenCalled();
			const result = await manager.execute("console.log(1 + 1)");
			expect(result.status).toBe("ok");
			expect(result.stdout).toContain("2");
			// AC-42: the script kind matches the in-package candidate, the python kind does not.
			expect(await resolveRuntimeSourceDir("script")).toBe(join(packageDir, "dist", "apollo-cli-runtime"));
			expect(await resolveRuntimeSourceDir("python")).not.toBe(join(packageDir, "dist", "apollo-cli-runtime"));
		} finally {
			process.chdir(previousCwd);
			vi.unstubAllEnvs();
			try {
				await manager?.kill();
			} finally {
				manager?.disposeSync();
				for (const dir of [packageDir, workCwd]) rmSync(dir, { recursive: true, force: true });
			}
		}
	});
});
