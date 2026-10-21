import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleRestore, handleSnapshot, recordUserGlobal } from "../src/rlm/repl.ts";

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
