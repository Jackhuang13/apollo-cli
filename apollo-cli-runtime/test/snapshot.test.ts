import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _setProtoWriter, _verifyRestoredGlobal, handleRestore, handleSnapshot, recordUserGlobal } from "../src/rlm/repl.ts";

test("snapshot and restore persists and restores user globals via v8 frames", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "apollo-snap-test-"));
	const snapPath = path.join(tempDir, "kernel-state.snap");
	const manifestPath = path.join(tempDir, "kernel-state.json");

	const g = globalThis as Record<string, unknown>;

	try {
		// Define and record user globals
		g.myString = "hello world";
		g.myNumber = 42.5;
		g.myArray = [1, "two", { three: 3 }];
		g.myObject = { nested: true, count: 10 };

		recordUserGlobal("myString");
		recordUserGlobal("myNumber");
		recordUserGlobal("myArray");
		recordUserGlobal("myObject");

		// Snapshot
		handleSnapshot({
			id: "snap-1",
			path: snapPath,
			manifest_path: manifestPath,
		});

		assert.ok(fs.existsSync(snapPath), "Snapshot binary payload must exist");
		assert.ok(fs.existsSync(manifestPath), "Manifest JSON must exist");

		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
		assert.ok(manifest.saved.includes("myString"));
		assert.ok(manifest.saved.includes("myNumber"));
		assert.ok(manifest.saved.includes("myArray"));
		assert.ok(manifest.saved.includes("myObject"));

		// Clear globals from memory
		delete g.myString;
		delete g.myNumber;
		delete g.myArray;
		delete g.myObject;

		assert.equal(g.myString, undefined);

		// Restore
		handleRestore({
			id: "restore-1",
			path: snapPath,
		});

		// Verify restored values
		assert.equal(g.myString, "hello world");
		assert.equal(g.myNumber, 42.5);
		assert.deepEqual(g.myArray, [1, "two", { three: 3 }]);
		assert.deepEqual(g.myObject, { nested: true, count: 10 });
	} finally {
		delete g.myString;
		delete g.myNumber;
		delete g.myArray;
		delete g.myObject;
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("snapshot skips unserializable types gracefully", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "apollo-snap-test-"));
	const snapPath = path.join(tempDir, "kernel-state.snap");
	const manifestPath = path.join(tempDir, "kernel-state.json");

	const g = globalThis as Record<string, unknown>;

	try {
		g.validData = "kept";
		g.fnGlobal = () => "cannot serialize function";
		g.symGlobal = Symbol("unserializable");

		recordUserGlobal("validData");
		recordUserGlobal("fnGlobal");
		recordUserGlobal("symGlobal");

		handleSnapshot({
			id: "snap-skip",
			path: snapPath,
			manifest_path: manifestPath,
		});

		assert.ok(fs.existsSync(manifestPath));
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
		assert.ok(manifest.saved.includes("validData"));

		const skippedNames = manifest.skipped.map((s: any) => s.name);
		assert.ok(skippedNames.includes("fnGlobal"));
		assert.ok(skippedNames.includes("symGlobal"));
	} finally {
		delete g.validData;
		delete g.fnGlobal;
		delete g.symGlobal;
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("restore probe handles circular references and complex structures safely", () => {
	// Circular reference
	const circular: Record<string, unknown> = { name: "circle" };
	circular.self = circular;
	const circleProbe = _verifyRestoredGlobal("circular", circular);
	assert.equal(circleProbe.verified, true);

	// Deep structure beyond MAX_RESTORE_VERIFY_DEPTH (3)
	const deep = { l1: { l2: { l3: { l4: "too deep" } } } };
	const deepProbe = _verifyRestoredGlobal("deep", deep);
	assert.equal(deepProbe.verified, false);
	assert.equal(deepProbe.reason, "complex_structure");

	// Builtin types: Map, Set, BigInt, RegExp
	const builtins = {
		m: new Map([["k", "v"]]),
		s: new Set([1, 2]),
		b: 100n,
		r: /test/i,
	};
	const builtinsProbe = _verifyRestoredGlobal("builtins", builtins);
	assert.equal(builtinsProbe.verified, true);
});

test("restore probe detects prototype_lost for custom class instances", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "apollo-snap-proto-"));
	const snapPath = path.join(tempDir, "kernel-state.snap");
	const manifestPath = path.join(tempDir, "kernel-state.json");

	class CustomWidget {
		label = "w";
		render() {
			return "<custom-widget/>";
		}
	}

	const g = globalThis as Record<string, unknown>;

	try {
		g.myWidget = new CustomWidget();
		recordUserGlobal("myWidget");

		handleSnapshot({
			id: "snap-proto",
			path: snapPath,
			manifest_path: manifestPath,
		});

		delete g.myWidget;

		// Intercept proto events to inspect event payload
		let donePayload: any;
		_setProtoWriter((line: string) => {
			try {
				const parsed = JSON.parse(line);
				if (parsed.event === "done" && parsed.id === "restore-proto") {
					donePayload = parsed;
				}
			} catch {}
			process.stdout.write(`${line}\n`);
		});

		try {
			handleRestore({
				id: "restore-proto",
				path: snapPath,
				manifest_path: manifestPath,
			});
		} finally {
			_setProtoWriter((line: string) => process.stdout.write(`${line}\n`));
		}

		assert.ok(donePayload, "donePayload must be captured");
		assert.ok(donePayload.restored.includes("myWidget"), "myWidget must be in restored");
		assert.ok(!donePayload.verified.includes("myWidget"), "myWidget must not be in verified");
		assert.deepEqual(donePayload.unverified, [{ name: "myWidget", reason: "prototype_lost" }]);

		// Verify restored value has lost its class method
		const restoredWidget = g.myWidget as any;
		assert.equal(restoredWidget.label, "w");
		assert.equal(typeof restoredWidget.render, "undefined");
	} finally {
		delete g.myWidget;
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("compaction pruning installs recoverable tombstones and reports skipped/pruned in restore", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "apollo-snap-prune-"));
	const snapPath = path.join(tempDir, "kernel-state.snap");
	const manifestPath = path.join(tempDir, "kernel-state.json");
	const g = globalThis as Record<string, unknown>;

	try {
		g.normalVar = "ok";
		g.hugeVar = Buffer.alloc(200); // oversized with maxVariableBytes = 100
		recordUserGlobal("normalVar");
		recordUserGlobal("hugeVar");

		let snapPayload: any;
		_setProtoWriter((line: string) => {
			try {
				const parsed = JSON.parse(line);
				if (parsed.event === "done" && parsed.id === "snap-prune") snapPayload = parsed;
			} catch {}
		});

		try {
			handleSnapshot({
				id: "snap-prune",
				path: snapPath,
				manifest_path: manifestPath,
				max_variable_bytes: 100,
				prune_oversized: true,
			});
		} finally {
			_setProtoWriter((line: string) => process.stdout.write(`${line}\n`));
		}

		assert.ok(snapPayload);
		assert.ok(snapPayload.saved.includes("normalVar"));
		assert.ok(!snapPayload.saved.includes("hugeVar"));
		assert.ok(snapPayload.pruned.some((p: any) => p.name === "hugeVar"));

		// Accessing hugeVar raises ReferenceError with compaction details
		assert.throws(
			() => {
				const _val = g.hugeVar;
			},
			/was removed during compaction/i,
		);

		// Overwriting hugeVar clears the tombstone and restores normal access
		g.hugeVar = 42;
		assert.equal(g.hugeVar, 42);

		// Clean up for restore check
		delete g.normalVar;
		delete g.hugeVar;

		let restorePayload: any;
		_setProtoWriter((line: string) => {
			try {
				const parsed = JSON.parse(line);
				if (parsed.event === "done" && parsed.id === "restore-prune") restorePayload = parsed;
			} catch {}
		});

		try {
			handleRestore({
				id: "restore-prune",
				path: snapPath,
				manifest_path: manifestPath,
			});
		} finally {
			_setProtoWriter((line: string) => process.stdout.write(`${line}\n`));
		}

		assert.ok(restorePayload);
		assert.ok(restorePayload.restored.includes("normalVar"));
		assert.ok(restorePayload.pruned.some((p: any) => p.name === "hugeVar"));

		// Re-installed tombstone after restore
		assert.throws(
			() => {
				const _val = g.hugeVar;
			},
			/was removed during compaction/i,
		);
	} finally {
		delete g.normalVar;
		delete g.hugeVar;
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});
