import * as fs from "node:fs";
import * as path from "node:path";

// Keep in sync with ATTACHMENT_DISPLAY_MIME / MAX_* in src/core/kernel/shared.ts.
const ATTACHMENT_DISPLAY_MIME = "application/vnd.apollo-cli.attachment+json";
const LEGACY_ATTACHMENT_DISPLAY_MIME = "application/vnd.prime-agent.attachment+json";
const MAX_SOURCE_IMAGE_BYTES = 20_000_000;
const MAX_SOURCE_IMAGE_PIXELS = 36_000_000;
const MAX_ATTACHMENT_DATA_CHARS = 350_000;
const MAX_ATTACHMENT_DIMENSION = 1200;

export class AttachImageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AttachImageError";
	}
}

export interface AttachImageOptions {
	label?: string;
}

export interface AttachImageResult {
	path: string;
	mime_type: string;
	mimeType: string;
	byte_size: number;
	byteSize: number;
	label: string;
	width: number;
	height: number;
}

function _detectImageMime(buf: Buffer, filePath: string): string {
	if (
		buf.byteLength >= 8 &&
		buf[0] === 0x89 &&
		buf[1] === 0x50 &&
		buf[2] === 0x4e &&
		buf[3] === 0x47 &&
		buf[4] === 0x0d &&
		buf[5] === 0x0a &&
		buf[6] === 0x1a &&
		buf[7] === 0x0a
	) {
		return "image/png";
	}
	if (buf.byteLength >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
		return "image/jpeg";
	}
	if (
		buf.byteLength >= 6 &&
		buf[0] === 0x47 &&
		buf[1] === 0x49 &&
		buf[2] === 0x46 &&
		buf[3] === 0x38 &&
		(buf[4] === 0x37 || buf[4] === 0x39) &&
		buf[5] === 0x61
	) {
		return "image/gif";
	}
	if (
		buf.byteLength >= 12 &&
		buf[0] === 0x52 &&
		buf[1] === 0x49 &&
		buf[2] === 0x46 &&
		buf[3] === 0x46 &&
		buf[8] === 0x57 &&
		buf[9] === 0x45 &&
		buf[10] === 0x42 &&
		buf[11] === 0x50
	) {
		return "image/webp";
	}
	throw new AttachImageError(
		`Unsupported image format for '${filePath}'. Supported formats: PNG, JPEG, GIF, WEBP.`,
	);
}

interface ImageDimensions {
	width: number;
	height: number;
}

// Reads pixel dimensions from the image header so the size/pixel caps can be
// enforced before the (base64) payload is built. No decoding is performed.
function _parseDimensions(buf: Buffer, filePath: string, mimeType: string): ImageDimensions {
	if (mimeType === "image/png") {
		if (buf.byteLength < 24) {
			throw new AttachImageError(`Could not read dimensions from PNG '${filePath}'.`);
		}
		return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
	}
	if (mimeType === "image/gif") {
		if (buf.byteLength < 10) {
			throw new AttachImageError(`Could not read dimensions from GIF '${filePath}'.`);
		}
		return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
	}
	if (mimeType === "image/webp") {
		if (buf.byteLength < 30) {
			throw new AttachImageError(`Could not read dimensions from WebP '${filePath}'.`);
		}
		const fourcc = buf.toString("ascii", 12, 16);
		if (fourcc === "VP8 ") {
			return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
		}
		if (fourcc === "VP8L") {
			const word = buf.readUInt32LE(21);
			return { width: (word & 0x3fff) + 1, height: ((word >>> 14) & 0x3fff) + 1 };
		}
		if (fourcc === "VP8X") {
			return {
				width: (buf.readUInt32LE(24) & 0xffffff) + 1,
				height: (buf.readUInt32LE(27) & 0xffffff) + 1,
			};
		}
		throw new AttachImageError(`Unsupported WebP variant '${fourcc}' in '${filePath}'.`);
	}
	if (mimeType === "image/jpeg") {
		let i = 2;
		while (i + 9 < buf.byteLength) {
			if (buf[i] !== 0xff) {
				i += 1;
				continue;
			}
			const marker = buf[i + 1]!;
			if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
				i += 2;
				continue;
			}
			if (
				marker >= 0xc0 &&
				marker <= 0xcf &&
				marker !== 0xc4 &&
				marker !== 0xc8 &&
				marker !== 0xcc
			) {
				return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
			}
			i += 2 + buf.readUInt16BE(i + 2);
		}
		throw new AttachImageError(`Could not find image dimensions in JPEG '${filePath}'.`);
	}
	throw new AttachImageError(`Unsupported image format for '${filePath}'.`);
}

export function attach_image(
	filePath: string,
	optionsOrLabel?: string | AttachImageOptions,
): AttachImageResult {
	const displayPath = String(filePath);
	const resolved = path.resolve(process.cwd(), displayPath);

	if (!fs.existsSync(resolved)) {
		throw new AttachImageError(`Image file not found: ${displayPath}`);
	}
	const stat = fs.statSync(resolved);
	if (stat.isDirectory()) {
		throw new AttachImageError(`Path is a directory, not an image file: ${displayPath}`);
	}

	const buf = fs.readFileSync(resolved);
	const size = buf.byteLength;
	if (size > MAX_SOURCE_IMAGE_BYTES) {
		throw new AttachImageError(
			`${displayPath} is ${Math.floor(size / 1_000_000)}MB; images must be under ` +
				`${MAX_SOURCE_IMAGE_BYTES / 1_000_000}MB. Resize it first.`,
		);
	}
	const mimeType = _detectImageMime(buf, displayPath);
	const { width, height } = _parseDimensions(buf, displayPath, mimeType);
	const pixelCount = width * height;
	if (pixelCount > MAX_SOURCE_IMAGE_PIXELS) {
		throw new AttachImageError(
			`${displayPath} is ${width}x${height} (${Math.floor(pixelCount / 1_000_000)}MP); ` +
				`images must be at most ${MAX_SOURCE_IMAGE_PIXELS / 1_000_000}MP. Resize it first.`,
		);
	}
	const longestSide = Math.max(width, height);
	if (longestSide > MAX_ATTACHMENT_DIMENSION) {
		throw new AttachImageError(
			`${displayPath} is ${width}x${height}; images must be at most ` +
				`${MAX_ATTACHMENT_DIMENSION}px on the longest side. Resize it first.`,
		);
	}
	const base64Data = buf.toString("base64");
	if (base64Data.length > MAX_ATTACHMENT_DATA_CHARS) {
		throw new AttachImageError(
			`${displayPath} would encode to ${base64Data.length} base64 chars; the attachment ` +
				`limit is ${MAX_ATTACHMENT_DATA_CHARS}. Resize it first.`,
		);
	}
	const label =
		typeof optionsOrLabel === "string"
			? optionsOrLabel
			: (optionsOrLabel?.label ?? displayPath);
	const payload = { mime_type: mimeType, data: base64Data, path: displayPath };

	const g = globalThis as { emit?: (data: Record<string, unknown>, metadata?: Record<string, unknown>) => void };
	if (typeof g.emit !== "function") {
		throw new AttachImageError("attach_image() must be called inside an active REPL cell.");
	}
	g.emit(
		{
			[ATTACHMENT_DISPLAY_MIME]: payload,
			[LEGACY_ATTACHMENT_DISPLAY_MIME]: payload,
			"text/plain": `Attached image: ${label} (${mimeType}, ${width}x${height}, ${size} bytes)`,
		},
		{
			path: displayPath,
			label,
			byte_size: size,
			mime_type: mimeType,
		},
	);

	return {
		path: displayPath,
		mime_type: mimeType,
		mimeType,
		byte_size: size,
		byteSize: size,
		label,
		width,
		height,
	};
}

export const attachImage = attach_image;
export default attach_image;
