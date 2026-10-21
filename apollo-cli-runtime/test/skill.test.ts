import test from "node:test";
import assert from "node:assert/strict";
import { cli, runCli } from "../src/rlm/skill.ts";

test("skill.ts parses positional and keyword arguments correctly", async () => {
	let capturedArgs: any[] = [];
	const testFn = (...args: any[]) => {
		capturedArgs = args;
		return "done";
	};

	await runCli(testFn, { argv: ["hello", "--count=3", "--verbose"] });
	assert.equal(capturedArgs[0], "hello");
	assert.deepEqual(capturedArgs[1], { count: 3, verbose: true });
});

test("skill.ts awaits async skill function results", async () => {
	const testAsyncFn = async (msg: string) => {
		return `async: ${msg}`;
	};

	await runCli(testAsyncFn, { argv: ["world"] });
});

test("skill.ts throws if module does not expose callable run()", async () => {
	await assert.rejects(
		async () => {
			await cli({});
		},
		{ message: /does not expose a callable run\(\)/ },
	);
});
