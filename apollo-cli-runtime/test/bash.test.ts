import test from "node:test";
import assert from "node:assert/strict";
import { _registerReplBridge, BASH_ACTIVITY_MIME, bash } from "../src/rlm/bash.ts";

function withActivityRecorder(
	fn: (awaitMatch: (pred: (a: Record<string, unknown>) => boolean) => Promise<Record<string, unknown>>) => Promise<void>,
): Promise<void> {
	const activities: Record<string, unknown>[] = [];
	const waiters = new Set<() => void>();
	_registerReplBridge({
		isActive: () => true,
		emit: (data) => {
			const activity = data[BASH_ACTIVITY_MIME] as Record<string, unknown> | undefined;
			if (!activity) return;
			activities.push(activity);
			for (const waiter of [...waiters]) waiter();
		},
		hostRequest: async () => ({ status: "ok" }),
		sendRawEvent: () => {},
		currentCellCompletionBarrier: () => Promise.resolve(),
	});
	const awaitMatch = (pred: (a: Record<string, unknown>) => boolean) =>
		new Promise<Record<string, unknown>>((resolve) => {
			const check = () => {
				const hit = activities.find(pred);
				if (hit) {
					waiters.delete(check);
					resolve(hit);
				}
			};
			waiters.add(check);
			check();
		});
	return fn(awaitMatch).finally(() =>
		_registerReplBridge({
			isActive: () => false,
			emit: () => {},
			hostRequest: async () => ({}),
			sendRawEvent: () => {},
			currentCellCompletionBarrier: () => null,
		}),
	);
}

test("bash() activity events carry the command, capped like the completion notice", async () => {
	await withActivityRecorder(async (awaitMatch) => {
		const handle1 = bash("sleep 0.1");
		const longCommand = `sleep 0.1 && echo ${"x".repeat(1197)}`;
		const handle2 = bash(longCommand, { timeout: null });
		const [a1, , a2, i2] = await Promise.all([
			awaitMatch((a) => a.pid === handle1.pid && a.active === true),
			awaitMatch((a) => a.pid === handle1.pid && a.active === false),
			awaitMatch((a) => a.pid === handle2.pid && a.active === true),
			awaitMatch((a) => a.pid === handle2.pid && a.active === false),
		]);
		const truncated = `${longCommand.slice(0, 1000)}\n... [command truncated]`;
		assert.equal(a1.command, "sleep 0.1");
		assert.equal(a2.command, truncated);
		assert.equal(i2.command, truncated);
		assert.deepEqual([a1.timeoutMs, a2.timeoutMs, i2.timeoutMs], [600_000, null, null]);
	});
});

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

test("bash() timeout options and scheduledTimeoutMs contract", async () => {
	const hDefault = bash("echo default");
	assert.equal(hDefault.scheduledTimeoutMs, 600_000);
	await hDefault;

	const h900 = bash("echo 900", { timeout: 900 });
	assert.equal(h900.scheduledTimeoutMs, 900_000);
	await h900;

	const hNull = bash("echo null", { timeout: null });
	assert.equal(hNull.scheduledTimeoutMs, null);
	await hNull;

	const hZero = bash("echo zero", { timeout: 0 });
	assert.equal(hZero.scheduledTimeoutMs, null);
	await hZero;
});

test("bash() descendants state parsing", async () => {
	const handle = bash("sh -c 'sleep 10'");
	await new Promise((resolve) => setTimeout(resolve, 100));
	const descendants = handle.descendants();
	if (process.platform === "linux") {
		assert.ok(descendants.length >= 1);
		for (const d of descendants) {
			assert.ok(typeof d.state === "string");
			assert.match(d.state, /^[RSDZTW]$/);
		}
	}
	handle.kill();
	await handle;
});
