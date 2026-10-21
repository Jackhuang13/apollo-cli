import { type ChildProcessWithoutNullStreams, execFileSync, spawn as spawnChild } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveKernelBashShell } from "../../src/utils/shell.js";

type Frame = Record<string, unknown>;

const RUNTIME_PATH = [
	resolve(process.cwd(), "../../apollo-cli-runtime/src/rlm/mod.ts"),
	resolve(__dirname, "../../../apollo-cli-runtime/src/rlm/mod.ts"),
].find((p) => existsSync(p));

/**
 * L1 driver: spawns the REAL apollo-cli-runtime mod.ts as a child process and
 * plays the host - NDJSON frames over stdin/stdout. No runtime code is mocked;
 * only the host peer (session manager side) is scripted.
 */
class L1Host {
	private child?: ChildProcessWithoutNullStreams;
	private buffer = "";
	private frames: Frame[] = [];
	private waiters: Array<{ predicate: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];

	start(timeoutMs = 15000): Promise<void> {
		return new Promise((ok, fail) => {
			if (!RUNTIME_PATH) return fail(new Error("apollo-cli-runtime/src/rlm/mod.ts not found"));
			const env: NodeJS.ProcessEnv = { ...process.env };
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
				let newline = this.buffer.indexOf("\n");
				while (newline >= 0) {
					const line = this.buffer.slice(0, newline).trim();
					this.buffer = this.buffer.slice(newline + 1);
					if (line) {
						try {
							const frame = JSON.parse(line) as Frame;
							if (frame.event === "ready") settle();
							this.push(frame);
						} catch {
							// non-JSON stdout is not a protocol frame
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
		for (const waiter of pending) {
			this.waiters.splice(this.waiters.indexOf(waiter), 1);
			waiter.resolve(frame);
		}
	}

	waitFrame(predicate: (f: Frame) => boolean, timeoutMs = 20000): Promise<Frame> {
		const buffered = this.frames.findIndex(predicate);
		if (buffered >= 0) {
			const [frame] = this.frames.splice(buffered, 1);
			return Promise.resolve(frame);
		}
		return new Promise<Frame>((resolveWait, rejectWait) => {
			// test-policy: allow wall-clock-timer -- bounds waiting on a real kernel frame; a matching frame resolves, the timer only fails
			const timer = setTimeout(() => rejectWait(new Error("timed out waiting for frame")), timeoutMs);
			this.waiters.push({
				predicate: (frame) => {
					clearTimeout(timer);
					return predicate(frame);
				},
				resolve: (frame) => resolveWait(frame),
			});
		});
	}

	send(frame: Frame): void {
		this.child?.stdin.write(`${JSON.stringify(frame)}\n`);
	}

	reply(id: string, data: Frame): void {
		this.send({ type: "host_reply", id, data });
	}

	/** Write raw (potentially invalid) text to the runtime stdin. */
	writeRaw(text: string): void {
		this.child?.stdin.write(text);
	}

	/** Execute a cell and return its result text (or undefined when void). */
	async runCell(id: string, code: string): Promise<string | undefined> {
		this.send({ type: "execute", id, code });
		const result = await this.waitFrame((f) => f.event === "result" && f.id === id);
		const done = await this.waitFrame((f) => f.event === "done" && f.id === id);
		expect(done.status).toBe("ok");
		return typeof result.text === "string" ? result.text : undefined;
	}

	async exit(timeoutMs = 10000): Promise<number> {
		const child = this.child;
		if (!child) return -1;
		if (child.exitCode !== null) return child.exitCode;
		return new Promise((resolveExit) => {
			// test-policy: allow wall-clock-timer -- bounds real subprocess teardown; the exit event resolves, the timer only force-kills
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
		if (this.child && this.child.exitCode === null) this.child.kill("SIGKILL");
	}
}

describe("rlm L1 core: real runtime, scripted host", () => {
	const host = new L1Host();

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

	it("L1-09 rlm.run rename guard and spawn name validation surface client-side errors", async () => {
		const renamed = await host.runCell(
			"l1-run",
			"(() => { try { void rlm.run; return 'absent'; } catch (e) { return String((e as Error).message); } })()",
		);
		expect(renamed).toContain("renamed to");
		const noName = await host.runCell(
			"l1-noname",
			"rlm.spawn({ prompt: 'x' }).then(() => 'spawned', (e) => String(e.message))",
		);
		expect(noName).toContain("requires a name");
	});

	it("L1-17 rlm.view numbers file lines, lists directories, and errors on missing paths", async () => {
		const dir = mkdtempSync(join(tmpdir(), "l1-view-"));
		try {
			writeFileSync(join(dir, "sample.txt"), "first line\nsecond line\nthird line\n");
			const file = await host.runCell(
				"l1-view-file",
				`rlm.view(${JSON.stringify(join(dir, "sample.txt"))}, { start: 2 })`,
			);
			expect(file).toContain("2|second line");
			expect(file).toContain("3|third line");
			expect(file).not.toContain("1|first line");
			const listing = await host.runCell("l1-view-dir", `rlm.view(${JSON.stringify(dir)})`);
			expect(listing).toContain("sample.txt");
			host.send({
				type: "execute",
				id: "l1-view-missing",
				code: `rlm.view(${JSON.stringify(join(dir, "nope.txt"))})`,
			});
			const error = await host.waitFrame((f) => f.event === "error" && f.id === "l1-view-missing");
			expect(String(error.evalue)).toContain("File not found");
			await host.waitFrame((f) => f.event === "done" && f.id === "l1-view-missing");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("L1-18 rlm.is_active is true inside a cell execution", async () => {
		const active = await host.runCell("l1-active", "String(rlm.is_active())");
		expect(active).toBe("'true'");
	});

	it("L1-12 bash captures >3.5MB output with head/tail retention and a dropped marker", async () => {
		const probe = await host.runCell(
			"l1-big",
			"const h = bash('yes a | head -c 10000000'); const r = await h; JSON.stringify({ code: r.exit_code, dropped: h.output().includes('bytes dropped'), head: h.output().startsWith('a') })",
		);
		const parsed = JSON.parse(probe!.slice(1, -1)) as { code: number; dropped: boolean; head: boolean };
		expect(parsed).toEqual({ code: 0, dropped: true, head: true });
	});

	it("L1-13 bash timeout kills a long command and reports a non-zero exit", async () => {
		const probe = await host.runCell(
			"l1-to",
			"const h = bash('sleep 60', { timeout: 2 }); const r = await h; JSON.stringify({ code: r.exit_code, seconds: r.duration })",
		);
		const parsed = JSON.parse(probe!.slice(1, -1)) as { code: number; seconds: number };
		expect(parsed.code).not.toBe(0);
		expect(parsed.seconds).toBeLessThan(15);
	});

	it("L1-14 bash kill escalates to SIGKILL when the group ignores SIGTERM", async () => {
		const probe = await host.runCell(
			"l1-kill",
			"const h = bash('trap : TERM; exec sleep 60'); h.kill(0.5); const r = await h; String(r.exit_code)",
		);
		expect(probe).toBe("'128'");
	});

	it("L1-16 a bash handle and its child survive across cells", async () => {
		await host.runCell("l1-cross-a", "globalThis.__l1h = bash('echo cross-cell-ok'); 'created'");
		const out = await host.runCell("l1-cross-b", "const r = await globalThis.__l1h; r.output");
		expect(out).toContain("cross-cell-ok");
	});

	it("L1-18h in-cell harness state persists to disk and reports in overview", async () => {
		const dir = mkdtempSync(join(tmpdir(), "l1-harness-"));
		try {
			const stateFile = join(dir, "harness_state.json");
			const overview = await host.runCell(
				"l1-harness",
				"const st = new rlm.HarnessState(" +
					JSON.stringify(stateFile) +
					"); st.create_memory('L1 Memory', 'l1 harness content'); st.overview()",
			);
			expect(overview).toContain("memory: 1");
			expect(readFileSync(stateFile, "utf8")).toContain("L1 Memory");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("L1-19 an MCP host error reply propagates to the caller through the bridge", async () => {
		host.send({
			type: "execute",
			id: "l1-mcp-none",
			code: "const t = new rlm.McpIntegration('l1nope'); t.call_tool('x', {}).then(() => 'ok', (e) => String(e))",
		});
		const callFrame = await host.waitFrame(
			(f) =>
				f.event === "host_request" &&
				(f.data as Frame).type === "mcp.call_tool" &&
				(f.data as Frame).server === "l1nope",
		);
		host.reply(String(callFrame.id ?? ""), { status: "error", error: "MCP server 'l1nope' is not enabled" });
		const result = await host.waitFrame((f) => f.event === "result" && f.id === "l1-mcp-none");
		expect(String(result.text)).toContain("not enabled");
		await host.waitFrame((f) => f.event === "done" && f.id === "l1-mcp-none");
	});

	it("L1-20 McpIntegration discovers and calls tools through the host bridge", async () => {
		host.send({
			type: "execute",
			id: "l1-mcp-bridge",
			code: "const t = new rlm.McpIntegration('l1srv'); const tools = await t.list_tools(); const out = await t.call_tool('t1', {}); JSON.stringify({ n: tools.length, out })",
		});
		const listFrame = await host.waitFrame(
			(f) => f.event === "host_request" && (f.data as Frame).type === "mcp.list_tools",
		);
		host.reply(String(listFrame.id ?? ""), {
			status: "ok",
			result: { tools: [{ name: "t1", description: "d", inputSchema: {} }] },
		});
		const callFrame = await host.waitFrame(
			(f) => f.event === "host_request" && (f.data as Frame).type === "mcp.call_tool",
		);
		expect(callFrame.data).toMatchObject({ server: "l1srv", tool: "t1", arguments: {} });
		host.reply(String(callFrame.id ?? ""), { status: "ok", result: { content: [{ text: "bridge-ok" }] } });
		const result = await host.waitFrame((f) => f.event === "result" && f.id === "l1-mcp-bridge");
		const parsed = JSON.parse(String(result.text).slice(1, -1)) as { n: number; out: string };
		expect(parsed).toEqual({ n: 1, out: "bridge-ok" });
		await host.waitFrame((f) => f.event === "done" && f.id === "l1-mcp-bridge");
	});

	it("L1-21 emit ships a display event with the cell id", async () => {
		host.send({ type: "execute", id: "l1-emit", code: 'emit({ "application/x-l1": { k: 1 } }); "sent"' });
		const display = await host.waitFrame((f) => f.event === "display" && f.id === "l1-emit");
		expect(display.data).toMatchObject({ "application/x-l1": { k: 1 } });
		await host.waitFrame((f) => f.event === "done" && f.id === "l1-emit");
	});

	it("L1-22 snapshot then restore round-trips user globals through v8 frames", async () => {
		const dir = mkdtempSync(join(tmpdir(), "l1-snap-"));
		const snapPath = join(dir, "state.snap");
		const manifestPath = join(dir, "state.json");
		try {
			await host.runCell("l1-snap-set", "globalThis.__l1snap = { a: 1, b: [1, 'two'] }; 'set'");
			host.send({ type: "snapshot", id: "l1-snap", path: snapPath, manifest_path: manifestPath });
			const complete = await host.waitFrame(
				(f) => f.id === "l1-snap" && f.event === "done" && Array.isArray(f.saved),
			);
			expect(complete.status).toBe("ok");
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { saved: string[] };
			expect(manifest.saved).toContain("__l1snap");
			host.send({ type: "execute", id: "l1-snap-del", code: "delete globalThis.__l1snap; 'deleted'", silent: true });
			await host.waitFrame((f) => f.event === "done" && f.id === "l1-snap-del");
			host.send({ type: "restore", id: "l1-res", path: snapPath });
			const restored = await host.waitFrame((f) => f.event === "done" && f.id === "l1-res");
			expect(restored.status).toBe("ok");
			const value = await host.runCell("l1-snap-get", "globalThis.__l1snap.a + '-' + globalThis.__l1snap.b[1]");
			expect(value).toBe("'1-two'");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("L1-23 interrupt aborts a running cell and the kernel keeps serving", async () => {
		host.send({
			type: "execute",
			id: "l1-int",
			code: 'emit({ "application/x-start": {} }); await new Promise((r) => setTimeout(r, 60000)); "never"',
		});
		const started = await host.waitFrame((f) => f.event === "display" && f.id === "l1-int");
		expect(started.data).toMatchObject({ "application/x-start": {} });
		host.send({ type: "interrupt" });
		const error = await host.waitFrame((f) => f.event === "error" && f.id === "l1-int");
		expect(String(error.ename)).toBe("KeyboardInterrupt");
		const done = await host.waitFrame((f) => f.event === "done" && f.id === "l1-int");
		expect(done.status).toBe("error");
		const after = await host.runCell("l1-int-after", "1 + 1");
		expect(after).toBe("2");
	});

	it("L1-24 non-JSON and pathologically deep protocol lines do not kill the reader", async () => {
		host.writeRaw("this is not json\n");
		host.writeRaw(`${"[".repeat(50000)}\n`);
		const alive = await host.runCell("l1-hostile", "2 + 2");
		expect(alive).toBe("4");
	});

	it("L1-26 dynamic imports and helpers execute without bash in cell", async () => {
		const code = [
			"const testPath = '/tmp/apollo-test-preinstalled-' + Date.now() + '.txt';",
			"write(testPath, 'hello preinstalled');",
			"const content = read(testPath);",
			"const yaml = await import('yaml');",
			"const y = yaml.stringify({ greeting: content, nums: [1, 2, 3] });",
			"const parsedY = yaml.parse(y);",
			"JSON.stringify({ content, count: parsedY.nums.length })",
		].join(" ");
		const res = await host.runCell("l1-tools-multi", code);
		expect(res).toContain('"content":"hello preinstalled"');
		expect(res).toContain('"count":3');
	});
});

describe("rlm L1 shutdown cleanup (dedicated child)", () => {
	it("L1-25 shutdown exits 0 and kills live background bash handles", async () => {
		const host = new L1Host();
		await host.start();
		try {
			const pidText = await host.runCell("l1-sh-pid", "String(bash('sleep 60').pid)");
			const pid = Number(pidText!.slice(1, -1));
			expect(Number.isSafeInteger(pid)).toBe(true);
			host.send({ type: "shutdown" });
			expect(await host.exit()).toBe(0);
			let cmd = "";
			try {
				cmd = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
			} catch {
				cmd = "";
			}
			expect(cmd).not.toContain("sleep 60");
		} finally {
			host.dispose();
		}
	});
});
