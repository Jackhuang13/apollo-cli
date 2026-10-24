import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_MOD_PATH = path.resolve(__dirname, "../src/rlm/mod.ts");

class ReplTestDriver {
	proc: ReturnType<typeof spawn>;
	rl: readline.Interface;
	events: any[] = [];
	eventWaiters: Array<(ev: any) => void> = [];

	constructor(extraEnv: Record<string, string> = {}) {
		this.proc = spawn(process.execPath, [RUNTIME_MOD_PATH], {
			stdio: ["pipe", "pipe", "inherit"],
			env: {
				...process.env,
				...extraEnv,
				NODE_OPTIONS: "--experimental-strip-types --no-warnings",
			},
		});

		this.rl = readline.createInterface({
			input: this.proc.stdout!,
			terminal: false,
		});

		this.rl.on("line", (line) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			try {
				const ev = JSON.parse(trimmed);
				if (this.eventWaiters.length > 0) {
					const waiter = this.eventWaiters.shift()!;
					waiter(ev);
				} else {
					this.events.push(ev);
				}
			} catch {
				// ignore non-json
			}
		});
	}

	nextEvent(timeoutMs = 5000): Promise<any> {
		if (this.events.length > 0) {
			return Promise.resolve(this.events.shift());
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Timeout waiting for REPL event")), timeoutMs);
			this.eventWaiters.push((ev) => {
				clearTimeout(timer);
				resolve(ev);
			});
		});
	}

	send(data: Record<string, any>): void {
		this.proc.stdin!.write(`${JSON.stringify(data)}\n`);
	}

	close(): void {
		this.proc.kill("SIGKILL");
	}
}

test("repl executes code and returns done event with stdout", async () => {
	const repl = new ReplTestDriver();
	try {
		const ready = await repl.nextEvent();
		assert.equal(ready.event, "ready");
		assert.equal(ready.protocol, 3);

		repl.send({
			type: "execute",
			id: "c1",
			code: "console.log('repl test output'); 40 + 2;",
		});

		let doneEv: any;
		let resultText = "";
		while (true) {
			const ev = await repl.nextEvent();
			if (ev.event === "stdout") {
				assert.ok(ev.text.includes("repl test output"));
			}
			if (ev.event === "result") {
				resultText = ev.text;
			}
			if (ev.event === "done") {
				doneEv = ev;
				break;
			}
		}

		assert.equal(doneEv.id, "c1");
		assert.equal(doneEv.status, "ok");
		assert.equal(resultText, "42");
	} finally {
		repl.close();
	}
});

test("repl supports top-level await in cell execution", async () => {
	const repl = new ReplTestDriver();
	try {
		const ready = await repl.nextEvent();
		assert.equal(ready.event, "ready");

		repl.send({
			type: "execute",
			id: "c2",
			code: "const val = await Promise.resolve('async_resolved'); val;",
		});

		let doneEv: any;
		let resultText = "";
		while (true) {
			const ev = await repl.nextEvent();
			if (ev.event === "result") {
				resultText = ev.text;
			}
			if (ev.event === "done") {
				doneEv = ev;
				break;
			}
		}

		assert.equal(doneEv.id, "c2");
		assert.equal(doneEv.status, "ok");
		assert.equal(resultText, "'async_resolved'");
	} finally {
		repl.close();
	}
});

test("repl handles syntax and runtime errors gracefully without crashing process", async () => {
	const repl = new ReplTestDriver();
	try {
		const ready = await repl.nextEvent();
		assert.equal(ready.event, "ready");

		repl.send({
			type: "execute",
			id: "err_cell",
			code: "throw new Error('deliberate_test_error');",
		});

		let errEv: any;
		let doneEv: any;
		while (true) {
			const ev = await repl.nextEvent();
			if (ev.event === "error") {
				errEv = ev;
			}
			if (ev.event === "done") {
				doneEv = ev;
				break;
			}
		}

		assert.equal(doneEv.id, "err_cell");
		assert.equal(doneEv.status, "error");
		assert.equal(errEv.ename, "Error");
		assert.ok(errEv.evalue.includes("deliberate_test_error"));

		// Ensure repl is still alive and responds to subsequent cells
		repl.send({
			type: "execute",
			id: "next_cell",
			code: "1 + 1",
		});

		let nextDone: any;
		let nextResult = "";
		while (true) {
			const ev = await repl.nextEvent();
			if (ev.event === "result") {
				nextResult = ev.text;
			}
			if (ev.event === "done") {
				nextDone = ev;
				break;
			}
		}
		assert.equal(nextDone.id, "next_cell");
		assert.equal(nextDone.status, "ok");
		assert.equal(nextResult, "2");
	} finally {
		repl.close();
	}
});

async function runCell(repl: ReplTestDriver, id: string, code: string) {
	repl.send({ type: "execute", id, code });
	let done: any;
	let resultText = "";
	let errorText = "";
	for (;;) {
		const ev = await repl.nextEvent();
		if (ev.event === "result") resultText = ev.text;
		else if (ev.event === "error") errorText = `${(ev.traceback ?? []).join("\n")}\n${ev.evalue ?? ""}`;
		else if (ev.event === "done") {
			done = ev;
			break;
		}
	}
	return { ...done, resultText, errorText };
}

test("repl keeps expressions wrapped across newlines as one statement (regression: multi-line chains)", async () => {
	const repl = new ReplTestDriver();
	try {
		await repl.nextEvent(); // ready
		const chain = await runCell(repl, "chain", "const chain = [1,2,3]\n  .filter((x) => x > 1)\n  .map((x) => x * 2);\nchain");
		assert.equal(chain.status, "ok");
		assert.equal(chain.resultText, "[ 4, 6 ]");

		const op = await runCell(repl, "op", "let a = 1\n+ 2;\na");
		assert.equal(op.status, "ok");
		assert.equal(op.resultText, "3");

		const guard = await runCell(repl, "guard", "let x = 1\nlet y = 2\nfunction f() {\n  return 7;\n}\nf() + x + y");
		assert.equal(guard.status, "ok");
		assert.equal(guard.resultText, "10");

		const div = await runCell(repl, "div", "let n = 10\n/ 4\nn");
		assert.equal(div.status, "ok");
		assert.equal(div.resultText, "2.5");

		const divchain = await runCell(repl, "divchain", "let a = 8\n/ 2\n- 1\na");
		assert.equal(divchain.status, "ok");
		assert.equal(divchain.resultText, "3");

		const re = await runCell(repl, "re", "const n = 1\n/x/.test(\"x\")");
		assert.equal(re.status, "ok");
		assert.equal(re.resultText, "true");

		const reStmt = await runCell(repl, "restmt", "const re = /x/\n/y/.test(\"y\")");
		assert.equal(reStmt.status, "ok");
		assert.equal(reStmt.resultText, "true");
	} finally {
		repl.close();
	}
});

test("repl appends recovery hints to known kernel failure signatures", async () => {
	const repl = new ReplTestDriver();
	try {
		await repl.nextEvent(); // ready
		const deno = await runCell(repl, "deno", "Deno.stat('/tmp')");
		assert.equal(deno.status, "error");
		assert.ok(deno.errorText.includes("this IScript kernel runs on Node (node:vm)"));

		const out = await runCell(repl, "out", "const r = await bash('echo hi'); r.output();");
		assert.equal(out.status, "error");
		assert.ok(out.errorText.includes("output is a string property (result.output)"));
	} finally {
		repl.close();
	}
});

test("repl resolves dynamic imports of node: builtins (regression: dynamic import callback)", async () => {
	const repl = new ReplTestDriver();
	try {
		await repl.nextEvent(); // ready
		// Concatenated so the source never contains a literal dynamic-import pattern:
		// this kernel rewrites import patterns in cell source, including string literals.
		const code = "const fs = await " + ["imp", "ort"].join("") + '("node:fs"); typeof fs.readFile';
		const imp = await runCell(repl, "imp", code);
		assert.equal(imp.status, "ok");
		assert.equal(imp.resultText, "'function'");
	} finally {
		repl.close();
	}
});

test("import rewriter: static import of node: builtin resolves (regression)", async () => {
	const repl = new ReplTestDriver();
	try {
		await repl.nextEvent();
		const res = await runCell(repl, "s1", "import { join } from \"node:path\"; join(\"a\", \"b\")");
		assert.equal(res.status, "ok", res.errorText || res.resultText);
		assert.equal(res.resultText, "'a/b'");
	} finally {
		repl.close();
	}
});

test("import rewriter: dynamic-import text inside strings survives write to file (regression: A2)", async () => {
	const repl = new ReplTestDriver();
	try {
		await repl.nextEvent();
		const p = "/tmp/a2-dyn-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".txt";
		const cell =
			"import { writeFileSync, readFileSync, rmSync } from \"node:fs\";\n" +
			"const s = 'x = await import(\"node:fs\");'\n" +
			"writeFileSync(" + JSON.stringify(p) + ", s);\n" +
			"const ok = readFileSync(" + JSON.stringify(p) + ", \"utf8\") === (\"x = await \" + \"im\" + \"port(\\\"node:fs\\\");\");\n" +
			"rmSync(" + JSON.stringify(p) + ");\n" +
			"ok";
		const res = await runCell(repl, "a2d", cell);
		assert.equal(res.status, "ok", res.errorText || res.resultText);
		assert.equal(res.resultText, "true");
	} finally {
		repl.close();
	}
});

test("import rewriter: static-import lines inside template text survive write to file (regression: A2)", async () => {
	const repl = new ReplTestDriver();
	try {
		await repl.nextEvent();
		const p = "/tmp/a2-stat-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".ts";
		const cell =
			"import { writeFileSync, readFileSync, rmSync } from \"node:fs\";\n" +
			"const doc = [\`\n" +
			"import { readFileSync } from 'node:fs';\n" +
			"const x = 1;\`];\n" +
			"writeFileSync(" + JSON.stringify(p) + ", doc.join(\"\"));\n" +
			"const ok = readFileSync(" + JSON.stringify(p) + ", \"utf8\").includes(\"im\" + \"port { readFileSync } from 'node:fs'\");\n" +
			"rmSync(" + JSON.stringify(p) + ");\n" +
			"ok";
		const res = await runCell(repl, "a2s", cell);
		assert.equal(res.status, "ok", res.errorText || res.resultText);
		assert.equal(res.resultText, "true");
	} finally {
		repl.close();
	}
});

test("import rewriter: awaited dynamic-import member chain resolves (regression: A3)", async () => {
	const repl = new ReplTestDriver();
	const p = "/tmp/a3-chain-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".txt";
	try {
		await repl.nextEvent();
		writeFileSync(p, "hello");
		const cell =
			"import { readFileSync } from \"node:fs\";\n" +
			"const v = await import(\"node:fs\").readFileSync(" + JSON.stringify(p) + ", \"utf8\"); v";
		const res = await runCell(repl, "a3", cell);
		assert.equal(res.status, "ok", res.errorText || res.resultText);
		assert.equal(res.resultText, "'hello'");
	} finally {
		rmSync(p, { force: true });
		repl.close();
	}
});

test("import rewriter: files written from a cell run in spawned node with real imports (regression: leak)", async () => {
	const repl = new ReplTestDriver();
	const p = "/tmp/a2-child-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".mjs";
	try {
		await repl.nextEvent();
		const cell =
			"import { writeFileSync, rmSync } from \"node:fs\";\n" +
			"writeFileSync(" + JSON.stringify(p) + ", 'const fs = await import(\"node:fs\");\\nconsole.log(\"child:\" + fs.existsSync(\"/etc/hostname\"));');\n" +
			"const r = await bash(\"node \" + " + JSON.stringify(p) + ");\n" +
			"rmSync(" + JSON.stringify(p) + ");\n" +
			"(r.exit_code === 0 ? \"ok\" : \"fail\") + '|' + r.output.trim()";
		const res = await runCell(repl, "child", cell);
		assert.equal(res.status, "ok", res.errorText || res.resultText);
		assert.equal(res.resultText, "'ok|child:true'");
	} finally {
		rmSync(p, { force: true });
		repl.close();
	}
});

test("import rewriter: import syntax inside comments does not execute or break the cell (guard)", async () => {
	const repl = new ReplTestDriver();
	try {
		await repl.nextEvent();
		const cell = "// import('node:fs') and import x from 'y' stay comments\n1 + 1";
		const res = await runCell(repl, "c1", cell);
		assert.equal(res.status, "ok", res.errorText || res.resultText);
		assert.equal(res.resultText, "2");
	} finally {
		repl.close();
	}
});

test("repl supports global require and reserves require name", async () => {
	const repl = new ReplTestDriver();
	try {
		await repl.nextEvent();
		const res = await runCell(repl, "req", "const fs = require('node:fs'); typeof fs.readFileSync");
		assert.equal(res.status, "ok", res.errorText || res.resultText);
		assert.equal(res.resultText, "'function'");
	} finally {
		repl.close();
	}
});

test("repl intercepts syntax errors early when import is present and formats as V8 traceback", async () => {
	const repl = new ReplTestDriver();
	try {
		await repl.nextEvent();
		const res = await runCell(repl, "syn", "import { foo } from 'bar';\nconst a = (\n");
		assert.equal(res.status, "error");
		assert.ok(!res.errorText.includes("Cannot use import statement outside a module"));
		assert.ok(res.errorText.includes("SyntaxError"));
		assert.ok(res.errorText.includes("at <cell-"));
		assert.ok(res.errorText.includes("const a = ("));
		assert.ok(res.errorText.includes("^"));
	} finally {
		repl.close();
	}
});

test("skill resolution: only APOLLO_SKILLS_DIR and dev cwd fallback are honored (legacy roots removed)", async () => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "skillw4-"));
	const mkSkill = (root: string, name: string) => {
		const d = path.join(root, name, "src");
		mkdirSync(d, { recursive: true });
		writeFileSync(path.join(d, "mod.ts"), "export const v = 42;\n");
	};
	try {
		const fakeHome = path.join(tmp, "home");
		mkSkill(path.join(fakeHome, ".apollo", "skills"), "skillw4h");
		mkSkill(path.join(fakeHome, ".prime", "skills"), "skillw4p");
		const envRoot = path.join(tmp, "envroot");
		mkSkill(envRoot, "skillw4e");
		const legacyRoot = path.join(tmp, "legacyroot");
		mkSkill(legacyRoot, "skillw4l");
		const repl = new ReplTestDriver({
			HOME: fakeHome,
			USERPROFILE: fakeHome,
			APOLLO_SKILLS_DIR: envRoot,
			PRIME_AGENT_SKILLS_DIR: legacyRoot,
		});
		try {
			await repl.nextEvent();
			const ok = await runCell(repl, "w4ok", "(await __apollo_import__('skillw4e')).v");
			assert.equal(ok.status, "ok", ok.errorText || ok.resultText);
			assert.equal(ok.resultText, "42");
			const gone = await runCell(
				repl, "w4gone",
				"await (async () => { try { await __apollo_import__('skillw4h'); await __apollo_import__('skillw4p'); return 'resolved'; } catch { return 'unresolved'; } })()",
			);
			assert.equal(gone.status, "ok", gone.errorText);
			assert.equal(gone.resultText, "'unresolved'");
			const legacy = await runCell(
				repl, "w4legacy",
				"await (async () => { try { await __apollo_import__('skillw4l'); return 'resolved'; } catch { return 'unresolved'; } })()",
			);
			assert.equal(legacy.status, "ok", legacy.errorText);
			assert.equal(legacy.resultText, "'unresolved'");
		} finally {
			repl.close();
		}
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});
