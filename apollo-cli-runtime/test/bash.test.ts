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
