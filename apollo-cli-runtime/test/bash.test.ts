import test from "node:test";
import assert from "node:assert/strict";
import { bash } from "../src/rlm/bash.ts";

test("bash() await returns result and exit code", async () => {
	const result = await bash("echo hi");
	assert.equal(result.exit_code, 0);
	assert.ok(result.output.includes("hi"));
	assert.ok(result.duration >= 0);

	const handle = bash("echo again");
	const awaited = await handle;
	assert.deepEqual(handle.poll(), awaited);
});

test("bash() captures non-zero exit code", async () => {
	const result = await bash("exit 42");
	assert.equal(result.exit_code, 42);
});

test("bash() supports tail output reading", async () => {
	const handle = bash("printf 'line1\nline2\nline3\n'");
	const res = await handle;
	assert.equal(res.exit_code, 0);
	assert.equal(handle.tail(2), "line2\nline3");
});

test("bash() supports killing running process", async () => {
	const handle = bash("sleep 10");
	assert.equal(handle.poll(), null);
	handle.kill(0.1);
	const res = await handle;
	assert.notEqual(res.exit_code, 0);
});

test("bash() tracks descendant processes and enforces timeout", async () => {
	const handle = bash("sleep 10 & sleep 11 & wait", { timeout: 0.3 });
	assert.equal(handle.poll(), null);

	// Wait briefly for subshells to spawn
	await new Promise((resolve) => setTimeout(resolve, 100));

	const descendants = handle.descendants();
	assert.ok(Array.isArray(descendants));
	if (process.platform !== "win32") {
		// Should identify sleep descendants
		assert.ok(descendants.length >= 1, `Expected descendants, got: ${JSON.stringify(descendants)}`);
		assert.ok(descendants.some((d) => d.comm?.includes("sleep")));
	}

	// Process should be terminated by timeout
	const res = await handle;
	assert.notEqual(res.exit_code, 0);

	// Wait briefly for reap cleanup and check descendants are terminated
	await new Promise((resolve) => setTimeout(resolve, 100));
	const afterReap = handle.descendants();
	assert.equal(afterReap.length, 0);
});
