import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/index.js";
import {
	buildRlmBootstrapCode,
	PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER,
	parseUnavailablePythonSkills,
} from "../src/core/tools/ipython.js";

describe("RLM bootstrap", () => {
	it("gives subagent registry operations the actionable missing-runtime fallback", () => {
		const code = buildRlmBootstrapCode();
		expect(code).toContain("find_models: raiseMissing");
		expect(code).toContain("list_subagents: raiseMissing");
		expect(code).toContain("delete_subagent: raiseMissing");
		expect(code).toContain("apollo-cli-runtime is not initialized in this kernel.");
	});

	it("disables colored output for subprocesses launched by the kernel", () => {
		expect(buildRlmBootstrapCode()).toContain('process.env["NO_COLOR"] = "1"');
	});

	it("binds bash from the runtime with a missing-runtime stub fallback", () => {
		const code = buildRlmBootstrapCode();
		expect(code).toContain("g.bash = () => {");
		expect(code).toContain("bash runtime is not initialized in this kernel.");
	});

	it("does not install a kernel shutdown hook (the runtime closes MCP on shutdown itself)", () => {
		expect(buildRlmBootstrapCode()).not.toContain("install_shutdown_hook");
	});

	it("guards skill imports so a broken skill does not abort bootstrap", () => {
		const code = buildRlmBootstrapCode([
			{
				name: "broken-skill",
				importName: "broken_skill",
				packagePath: "/tmp/broken-skill",
				pyprojectPath: "/tmp/broken-skill/pyproject.toml",
			},
		]);

		expect(code).toContain("globalThis.__apollo_import__");
		expect(code).toContain("importErrors[skillName]");
		expect(code).toContain(PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER);
	});

	it.each([
		[
			`${PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER}{"websearch":"No module named 'websearch'"}\n`,
			{ websearch: "No module named 'websearch'" },
		],
		[`noise\n${PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER}{"edit":"boom"}`, { edit: "boom" }],
		["some unrelated kernel output", undefined],
		[`${PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER}not json`, undefined],
		[`${PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER}{}`, undefined],
	])("parses %j as %j", (stdout, expected) => {
		expect(parseUnavailablePythonSkills(stdout as string)).toEqual(expected);
	});
});

describe("RLM bootstrap (real kernel)", () => {
	const dir = mkdtempSync(join(tmpdir(), "apollo-bootstrap-"));

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("binds environment and globals in the IScript user namespace", async () => {
		const manager = new ReplKernelManager({ cwd: dir });
		try {
			await manager.start();
			const bootstrap = await manager.execute(buildRlmBootstrapCode());
			expect(bootstrap.status).toBe("ok");

			const envResult = await manager.execute('console.log(process.env["NO_COLOR"])');
			expect(envResult.status).toBe("ok");
			expect(envResult.stdout.trim()).toBe("1");

			const rlmCheck = await manager.execute("typeof rlm.spawn");
			expect(rlmCheck.status).toBe("ok");
			expect(rlmCheck.result).toContain("function");

			const bashCheck = await manager.execute("typeof bash");
			expect(bashCheck.status).toBe("ok");
			expect(bashCheck.result).toContain("function");
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});
});
