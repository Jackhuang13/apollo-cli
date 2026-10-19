import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attach_image } from "../skills/attach-image/src/attach_image/mod.js";
import {
	ATTACHMENT_DISPLAY_MIME,
	LEGACY_ATTACHMENT_DISPLAY_MIME,
	parseAttachmentDisplay,
} from "../src/core/kernel/shared.js";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngBuffer(width: number, height: number, padBytes = 0): Buffer {
	const chunk = Buffer.alloc(25);
	chunk.writeUInt32BE(13, 0);
	chunk.write("IHDR", 4, "ascii");
	chunk.writeUInt32BE(width, 8);
	chunk.writeUInt32BE(height, 12);
	chunk[16] = 8;
	chunk[17] = 2;
	const parts: Buffer[] = [PNG_SIG, chunk];
	if (padBytes > 0) parts.push(Buffer.alloc(padBytes));
	return Buffer.concat(parts);
}

function jpegBuffer(width: number, height: number): Buffer {
	const b = Buffer.alloc(12);
	b[0] = 0xff;
	b[1] = 0xd8;
	b[2] = 0xff;
	b[3] = 0xc0;
	b[4] = 0x00;
	b[5] = 0x0b;
	b[6] = 0x08;
	b.writeUInt16BE(height, 7);
	b.writeUInt16BE(width, 9);
	b[11] = 0x03;
	return b;
}

describe("attach_image TS skill payload and caps (AC-26/AC-27)", () => {
	let tempDir: string;
	let emitSpy: ReturnType<typeof vi.fn>;
	const originalEmit = (globalThis as Record<string, unknown>).emit;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-attach-ts-"));
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

	function emittedPayload(): unknown {
		const call = emitSpy.mock.calls[0];
		const data = call[0] as Record<string, unknown>;
		return data[ATTACHMENT_DISPLAY_MIME] ?? data[LEGACY_ATTACHMENT_DISPLAY_MIME];
	}

	it("emits a parseAttachmentDisplay-accepted structured payload for a small PNG", () => {
		const file = join(tempDir, "small.png");
		const buf = pngBuffer(10, 10);
		writeFileSync(file, buf);
		const result = attach_image(file);
		expect(result.width).toBe(10);
		expect(result.height).toBe(10);
		const parsed = parseAttachmentDisplay(emittedPayload());
		expect(parsed).toBeDefined();
		expect(parsed !== "oversized").toBe(true);
		expect((parsed as { mimeType: string }).mimeType).toBe("image/png");
		expect((parsed as { data: string }).data).toBe(buf.toString("base64"));
	});

	it("reads JPEG dimensions from the SOF marker", () => {
		const file = join(tempDir, "small.jpg");
		writeFileSync(file, jpegBuffer(50, 40));
		const result = attach_image(file);
		expect(result.mime_type).toBe("image/jpeg");
		expect(result.width).toBe(50);
		expect(result.height).toBe(40);
	});

	it.each([
		[2000, 10, /longest side/],
		[7000, 7000, /MP/],
	])("rejects a %dx%d PNG that exceeds the dimension/pixel caps", (w, h, re) => {
		const file = join(tempDir, `big-${w}x${h}.png`);
		writeFileSync(file, pngBuffer(w, h));
		expect(() => attach_image(file)).toThrow(re);
		expect(emitSpy).not.toHaveBeenCalled();
	});

	it("rejects a file whose base64 exceeds the attachment data cap", () => {
		const file = join(tempDir, "fat.png");
		writeFileSync(file, pngBuffer(10, 10, 300_000));
		expect(() => attach_image(file)).toThrow(/base64/);
		expect(emitSpy).not.toHaveBeenCalled();
	});

	it("rejects a source image larger than the byte cap", () => {
		const file = join(tempDir, "huge.png");
		writeFileSync(file, pngBuffer(10, 10, 20_000_001));
		expect(() => attach_image(file)).toThrow(/MB/);
		expect(emitSpy).not.toHaveBeenCalled();
	});
});
