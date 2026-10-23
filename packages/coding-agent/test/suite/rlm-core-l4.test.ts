import { type ChildProcessWithoutNullStreams, spawn as spawnChild } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	isOrphanProcessIdentityCurrent,
	ORPHAN_PROCESS_JOURNAL_ENV,
	readActiveOrphanProcesses,
	reapKernelOrphanProcesses,
	shouldReapOrphanProcess,
} from "../../src/core/orphan-process-journal.js";
import { resolveKernelBashShell } from "../../src/utils/shell.js";

type Frame = Record<string, unknown>;

const RUNTIME_PATH = [
	resolve(process.cwd(), "../../apollo-cli-runtime/src/rlm/mod.ts"),
	resolve(__dirname, "../../../apollo-cli-runtime/src/rlm/mod.ts"),
].find((p) => existsSync(p));

// L4 driver: same real-kernel/scripted-host boundary as L1, with env overrides
// and access to the child handle for chaos scenarios (kill -9, pipe destroy).
class L4Host {
	child?: ChildProcessWithoutNullStreams;
	private buffer = "";
	private frames: Frame[] = [];
	private waiters: Array<{ predicate: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];

	start(extraEnv?: Record<string, string>, timeoutMs = 15000): Promise<void> {
		return new Promise((ok, fail) => {
			if (!RUNTIME_PATH) return fail(new Error("runtime mod.ts not found"));
			const env: NodeJS.ProcessEnv = { ...process.env, ...(extraEnv ?? {}) };
			const shell = resolveKernelBashShell();
			if (shell) env.PRIME_AGENT_BASH_SHELL = shell;
			const child = spawnChild(process.execPath, ["--experimental-strip-types", RUNTIME_PATH], {
				env,
				stdio: ["pipe", "pipe", "pipe"],
			});
			this.child = child;
			let settled = false;
			const settle = (): void => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					ok();
				}
			};
			// test-policy: allow wall-clock-timer -- bounds a real subprocess ready handshake; the ready frame resolves, the timer only fails
			const timer = setTimeout(() => {
				if (!settled) {
					settled = true;
					fail(new Error("runtime did not emit ready"));
				}
			}, timeoutMs);
			child.stdout.on("data", (chunk: Buffer) => {
				this.buffer += chunk.toString("utf8");
				let nl = this.buffer.indexOf("\n");
				while (nl >= 0) {
					const line = this.buffer.slice(0, nl).trim();
					this.buffer = this.buffer.slice(nl + 1);
					if (line) {
						try {
							const frame = JSON.parse(line) as Frame;
							if (frame.event === "ready") settle();
							this.push(frame);
						} catch {
							/* not a frame */
						}
					}
					nl = this.buffer.indexOf("\n");
				}
			});
			child.stderr.on("data", () => undefined);
			child.on("error", (err) => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					fail(err);
				}
			});
		});
	}

	private push(frame: Frame): void {
		const pending = this.waiters.filter((w) => w.predicate(frame));
		if (pending.length === 0) {
			this.frames.push(frame);
			return;
		}
		for (const w of pending) {
			this.waiters.splice(this.waiters.indexOf(w), 1);
			w.resolve(frame);
		}
	}

	waitFrame(predicate: (f: Frame) => boolean, timeoutMs = 30000): Promise<Frame> {
		const idx = this.frames.findIndex(predicate);
		if (idx >= 0) {
			const [frame] = this.frames.splice(idx, 1);
			return Promise.resolve(frame);
		}
		return new Promise<Frame>((res, rej) => {
			// test-policy: allow wall-clock-timer -- bounds waiting on a real kernel frame; a matching frame resolves, the timer only fails
			const timer = setTimeout(() => rej(new Error("timed out waiting for frame")), timeoutMs);
			this.waiters.push({
				predicate: (f) => {
					clearTimeout(timer);
					return predicate(f);
				},
				resolve: res,
			});
		});
	}

	send(frame: Frame): void {
		this.child?.stdin.write(`${JSON.stringify(frame)}\n`);
	}
	reply(id: string, data: Frame): void {
		this.send({ type: "host_reply", id, data });
	}

	async runCell(id: string, code: string): Promise<string | undefined> {
		this.send({ type: "execute", id, code });
		const result = await this.waitFrame((f) => f.event === "result" && f.id === id);
		await this.waitFrame((f) => f.event === "done" && f.id === id);
		return typeof result.text === "string" ? result.text : undefined;
	}

	async exit(timeoutMs = 10000): Promise<number> {
		const child = this.child;
		if (!child) return -1;
		if (child.exitCode !== null) return child.exitCode;
		return new Promise((res) => {
			// test-policy: allow wall-clock-timer -- bounds real subprocess teardown; the exit event resolves, the timer only force-kills
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				res(-1);
			}, timeoutMs);
			child.on("exit", (code) => {
				clearTimeout(timer);
				res(code ?? -1);
			});
		});
	}

	async stop(): Promise<void> {
		try {
			this.send({ type: "shutdown" });
			await this.exit();
		} finally {
			this.child?.kill("SIGKILL");
		}
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function processState(pid: number): string | null {
	try {
		return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[0];
	} catch {
		return null;
	}
}

async function awaitNotRunning(pid: number, timeoutMs = 10000): Promise<void> {
	const startAt = Date.now();
	while (processState(pid) !== null && processState(pid) !== "Z") {
		if (Date.now() - startAt > timeoutMs) throw new Error(`pid ${pid} still running after reap`);
		// test-policy: allow wall-clock-timer -- the concrete /proc state change (reap) resolves; the deadline only fails
		await new Promise((r) => setTimeout(r, 20));
	}
}

describe("rlm L4 robustness: real runtime chaos", () => {
	it("L4-01 kill -9 of the kernel journals its bash child and the host reaper kills it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "l4-orphan-"));
		const prevJournal = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
		try {
			const journal = join(dir, "orphan.jsonl");
			process.env[ORPHAN_PROCESS_JOURNAL_ENV] = journal; // host-side reaper reads the same journal
			const host = new L4Host();
			try {
				await host.start({
					APOLLO_INTERNAL_ORPHAN_PROCESS_JOURNAL: journal,
					APOLLO_KERNEL_OWNER_PID: String(process.pid),
				});
				const kernelPid = host.child?.pid as number;
				const out = await host.runCell("l4o1", "const h = bash('sleep 300'); JSON.stringify({ pid: h.pid })");
				const pid = (JSON.parse(out!.slice(1, -1)) as { pid: number }).pid;
				const records = readFileSync(journal, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((l) => JSON.parse(l) as Frame);
				const rec = records.find((r) => r.pid === pid && r.active === true);
				expect(rec).toBeTruthy();
				expect(rec?.kernelPid).toBe(kernelPid);
				host.child?.kill("SIGKILL"); // kill -9: no shutdown, no cleanup
				await host.exit();
				expect(isAlive(pid)).toBe(true); // child is now an orphan
				const orphans = readActiveOrphanProcesses(journal, process.pid);
				const orphan = orphans.find((o) => o.pid === pid);
				expect(orphan).toBeTruthy();
				expect(isOrphanProcessIdentityCurrent(orphan!)).toBe(true);
				expect(shouldReapOrphanProcess(orphan!)).toBe(true);
				reapKernelOrphanProcesses(kernelPid); // the host's real crash-reap path
				expect(readActiveOrphanProcesses(journal, process.pid).find((o) => o.pid === pid)).toBeUndefined(); // recorded inactive
				await awaitNotRunning(pid); // killed and reaped: no permanent orphan
			} finally {
				await host.stop();
			}
		} finally {
			if (prevJournal === undefined) delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
			else process.env[ORPHAN_PROCESS_JOURNAL_ENV] = prevJournal;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("L4-02 closing the host pipe rejects pending host requests and exits the kernel", async () => {
		const host = new L4Host();
		try {
			await host.start();
			host.send({
				type: "execute",
				id: "l4o2",
				code: "rlm.spawn({ prompt: 'p', name: 'l4c2' }).then(() => 'spawned', (e) => 'REJ:' + e.message)",
			});
			const req = await host.waitFrame((f) => f.event === "host_request" && (f.data as Frame).type === "rlm.run");
			expect(req.id).toBeTruthy();
			host.child?.stdin.destroy(); // host disconnect: kernel stdin closes
			const result = await host.waitFrame((f) => f.event === "result" && f.id === "l4o2");
			expect(String(result.text)).toContain("REJ:host connection closed");
			await host.waitFrame((f) => f.event === "done" && f.id === "l4o2");
			expect(await host.exit()).not.toBe(-1); // kernel exited on its own, no hang
		} finally {
			await host.stop();
		}
	});

	it("L4-03 five concurrent rlm.spawn calls all admit with unique ids", async () => {
		const host = new L4Host();
		try {
			await host.start();
			host.send({
				type: "execute",
				id: "l4o3",
				code: "const ps = [1,2,3,4,5].map((i) => rlm.spawn({ prompt: 'p' + i, name: 'l4c' + i })); const rs = await Promise.all(ps); JSON.stringify(rs.map((r) => r.rlm_child_id))",
			});
			for (let i = 0; i < 5; i++) {
				const req = await host.waitFrame((f) => f.event === "host_request" && (f.data as Frame).type === "rlm.run");
				host.reply(String(req.id), {
					status: "ok",
					result: { rlm_child_id: `sub-l4-${i}`, session_name: `l4c${i}` },
				});
			}
			const result = await host.waitFrame((f) => f.event === "result" && f.id === "l4o3");
			const ids = JSON.parse(String(result.text).slice(1, -1)) as string[];
			expect(ids).toHaveLength(5);
			expect(new Set(ids).size).toBe(5);
			await host.waitFrame((f) => f.event === "done" && f.id === "l4o3");
		} finally {
			await host.stop();
		}
	});

	it("L4-04 a snapshot requested during a long cell is queued and completes after it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "l4-snapq-"));
		try {
			const host = new L4Host();
			try {
				await host.start();
				await host.runCell("l4o4-pre", "pre = 42; 'ok'");
				host.send({
					type: "execute",
					id: "l4o4-cell",
					code: "await new Promise((r) => setTimeout(r, 2500)); during = 'x'; 'long-done'",
				});
				host.send({ type: "snapshot", id: "l4o4-snap", path: join(dir, "k.bin") });
				const cellDone = await host.waitFrame((f) => f.event === "done" && f.id === "l4o4-cell");
				expect(cellDone.status).toBe("ok");
				const cellAt = Date.now();
				const snapDone = await host.waitFrame((f) => f.event === "done" && f.id === "l4o4-snap");
				expect(snapDone.status).toBe("ok");
				expect(Date.now() >= cellAt).toBe(true); // queued: answered only after the cell settled
				const saved = snapDone.saved as string[];
				expect(saved).toContain("pre");
				expect(saved).toContain("during"); // snapshot ran after the cell finished, seeing its final state
				expect(await host.runCell("l4o4-post", "String(pre + 1)")).toBe("'43'"); // kernel healthy afterwards
			} finally {
				await host.stop();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("L4-05 an over-limit variable is pruned with a manifest hint and absent after restore", async () => {
		const dir = mkdtempSync(join(tmpdir(), "l4-prune-"));
		try {
			const snap = join(dir, "k.bin");
			const man = join(dir, "k.manifest.json");
			const host = new L4Host();
			try {
				await host.start();
				await host.runCell("l4o5-set", "big = 'x'.repeat(20 * 1024 * 1024); small = 'keep-me'; 'ok'");
				host.send({ type: "snapshot", id: "l4o5", path: snap, manifest_path: man, prune_oversized: true });
				const done = await host.waitFrame((f) => f.event === "done" && f.id === "l4o5");
				expect(done.status).toBe("ok");
				expect(done.saved as string[]).toContain("small");
				const pruned = done.pruned as Array<{ name: string; size_bytes: number }>;
				expect(pruned.find((p) => p.name === "big" && p.size_bytes > 16 * 1024 * 1024)).toBeTruthy();
				expect(await host.runCell("l4o5-gone", "typeof big")).toBe("'undefined'"); // pruned from live globals
				const manifest = JSON.parse(readFileSync(man, "utf8")) as Frame;
				expect((manifest.pruned as Array<Frame>).find((p) => p.name === "big")).toBeTruthy(); // manifest records the drop
				const host2 = new L4Host();
				try {
					await host2.start();
					host2.send({ type: "restore", id: "l4o5r", path: snap });
					const rd = await host2.waitFrame((f) => f.event === "done" && f.id === "l4o5r");
					expect(rd.status).toBe("ok");
					expect(rd.restored as string[]).toContain("small");
					expect((rd.restored as string[]).includes("big")).toBe(false);
					const check = await host2.runCell("l4o5-check", "JSON.stringify({ small: small, big: typeof big })");
					expect(JSON.parse(check!.slice(1, -1))).toEqual({ small: "keep-me", big: "undefined" });
				} finally {
					await host2.stop();
				}
			} finally {
				await host.stop();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
