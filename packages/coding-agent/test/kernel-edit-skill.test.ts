import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EDIT_DIFF_MIME, edit, LEGACY_EDIT_DIFF_MIME } from "../skills/edit/src/edit/mod.js";
import { parseDiffDisplay } from "../src/core/kernel/shared.js";

describe("edit skill diff display payload (AC-25)", () => {
	let tempDir: string;
	let emitSpy: ReturnType<typeof vi.fn>;
	const originalEmit = (globalThis as Record<string, unknown>).emit;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-edit-skill-"));
		emitSpy = vi.fn();
		(globalThis as Record<string, unknown>).emit = emitSpy;
	});

	afterEach(() => {
		if (originalEmit === undefined) {
			delete (globalThis as Record<string, unknown>).emit;
		} else {
			(globalThis as Record<string, unknown>).emit = originalEmit;
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	function capturedDiffPayloads(): unknown[] {
		const payloads: unknown[] = [];
		for (const call of emitSpy.mock.calls) {
			const data = call[0] as Record<string, unknown>;
			const payload = data[EDIT_DIFF_MIME] ?? data[LEGACY_EDIT_DIFF_MIME];
			if (payload !== undefined) payloads.push(payload);
		}
		return payloads;
	}

	it("emits a parseDiffDisplay-accepted payload with old/new and start_line", () => {
		const file = join(tempDir, "sample.txt");
		writeFileSync(file, "alpha\nbeta\ngamma\n");
		edit(file, "beta", "BETA");
		const payloads = capturedDiffPayloads();
		expect(payloads).toHaveLength(1);
		const parsed = parseDiffDisplay(payloads[0]);
		expect(parsed).toBeDefined();
		expect(parsed!.path).toBe(file);
		expect(parsed!.oldStr).toBe("beta");
		expect(parsed!.newStr).toBe("BETA");
		expect(parsed!.startLine).toBe(2);
	});

	it("emits one payload per applied change for an array edit", () => {
		const file = join(tempDir, "multi.txt");
		writeFileSync(file, "one\ntwo\nthree\n");
		edit(file, [
			{ old: "one", new: "ONE" },
			{ old: "three", new: "THREE" },
		]);
		const payloads = capturedDiffPayloads();
		expect(payloads).toHaveLength(2);
		const parsed = payloads.map(parseDiffDisplay);
		expect(parsed.every((p) => p !== undefined)).toBe(true);
		expect(parsed[0]!.startLine).toBe(1);
		expect(parsed[1]!.startLine).toBe(3);
	});
});
