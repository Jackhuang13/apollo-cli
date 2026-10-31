import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("edit skill not-found hardening", () => {
	let tempDir: string;
	let emitSpy: ReturnType<typeof vi.fn>;
	const originalEmit = (globalThis as Record<string, unknown>).emit;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-edit-hardening-"));
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

	it.each([
		[
			"literal \\n from String.raw",
			"alpha\nline one\nline two\ngamma\n",
			"line one\\nline two",
			"LINE ONE\nLINE TWO",
			"alpha\nLINE ONE\nLINE TWO\ngamma\n",
		],
		["literal \\t", "a\tb\n", "a\\tb", "a  b", "a  b\n"],
		[
			"double backslash in regex literal",
			"x = r'Fatal:\\s+'\n",
			"r'Fatal:\\\\s+'",
			"r'Fatal:.*'",
			"x = r'Fatal:.*'\n",
		],
		[
			"String.raw backtick escape",
			"note: `tick` here\n",
			"note: \\`tick\\` here",
			"note: TICK here",
			"note: TICK here\n",
		],
		[
			"String.raw template escape",
			"value: " + "$" + "{name}\n",
			"value: \\" + "$" + "{name}",
			"value: " + "$" + "{NAME}",
			"value: " + "$" + "{NAME}\n",
		],
	])(
		"escape-repair applies a unique unescaped match and marks the result: %s",
		(_name, fileBody, oldText, newText, expected) => {
			const file = join(tempDir, "repair.txt");
			writeFileSync(file, fileBody);
			const result = edit(file, oldText, newText);
			expect(result.repaired).toBe(true);
			expect(readFileSync(file, "utf8")).toBe(expected);
			const plain = emitSpy.mock.calls.map((c) => (c[0] as Record<string, unknown>)["text/plain"]).join(" ");
			expect(plain).toContain("(auto-repaired escape sequences)");
		},
	);

	it("escape-repair rejects an ambiguous match with the occurrence count and leaves the file untouched", () => {
		const file = join(tempDir, "ambiguous.txt");
		writeFileSync(file, "a\nb\na\nb\ntail\n");
		expect(() => edit(file, "a\\nb", "X")).toThrow(/2 occurrences.*after escape repair/);
		expect(readFileSync(file, "utf8")).toBe("a\nb\na\nb\ntail\n");
	});

	it("fuzzy match splices only the matched region and keeps surrounding bytes intact", () => {
		const file = join(tempDir, "fuzzy.txt");
		writeFileSync(file, "step \u2460 first\r\nsay \u201Chello\u201D there   \r\nbeta\r\n");
		const result = edit(file, 'say "hello" there', "say HI there");
		expect(result.repaired).toBeUndefined();
		expect(readFileSync(file, "utf8")).toBe("step \u2460 first\r\nsay HI there   \r\nbeta\r\n");
		const parsed = parseDiffDisplay(capturedDiffPayloads()[0]);
		expect(parsed!.oldStr).toBe("say \u201Chello\u201D there");
		expect(parsed!.newStr).toBe("say HI there");
	});

	it("not-found diagnostics handle a multi-line window without stalling (regression: off-by-one newline walk)", () => {
		const file = join(tempDir, "missing-multi.txt");
		writeFileSync(file, "alpha\nbeta\nconst deltaLine = 1;\nconst eps = 3;\ngamma\n");
		let message = "";
		try {
			edit(file, "const deltaLine = 1;\nconst eps = 2;", "nope");
		} catch (err) {
			message = (err as Error).message;
		}
		expect(message).toContain("First diff at char 33 (file line 4, col 13)");
	});

	it("not-found diagnostics report correct line and col when the diff is on the first window line", () => {
		const file = join(tempDir, "missing-first-line.txt");
		writeFileSync(file, "alpha\nconst eps = 3;\nconst zeta = 1;\n");
		let message = "";
		try {
			edit(file, "const eps = 2;\nconst zeta = 1;", "nope");
		} catch (err) {
			message = (err as Error).message;
		}
		expect(message).toContain("First diff at char 12 (file line 2, col 13)");
	});

	it("not-found diagnostics still find the closest line in the second half of large files", () => {
		const file = join(tempDir, "missing-large-file.txt");
		const rows: string[] = [];
		for (let i = 0; i < 2500; i++) {
			rows.push(
				i === 2000
					? "const markerLine = 1;"
					: `filler line ${i} with enough padding to pass the ratio filter easily`,
			);
		}
		writeFileSync(file, rows.join("\n"));
		let message = "";
		try {
			edit(file, "const markerLine = 2;", "nope");
		} catch (err) {
			message = (err as Error).message;
		}
		expect(message).toContain("file line 2001");
	});

	it("not-found failure keeps the prefix and reports first diff plus a copyable window", () => {
		const file = join(tempDir, "missing.txt");
		writeFileSync(file, "alpha\nconst betaLine = 1;\ngamma\n");
		let message = "";
		try {
			edit(file, "const betaLine = 2;", "const betaLine = 3;");
		} catch (err) {
			message = (err as Error).message;
		}
		expect(message).toContain("Could not find the exact text");
		expect(message).toContain("First diff at char 17 (file line 2, col 18)");
		expect(message).toContain("const betaLine = 1;");
		expect(readFileSync(file, "utf8")).toBe("alpha\nconst betaLine = 1;\ngamma\n");
	});
});
