import * as fs from "node:fs";
import * as path from "node:path";

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
	const mimeType = _detectImageMime(buf, displayPath);
	const base64Data = buf.toString("base64");
	const label =
		typeof optionsOrLabel === "string"
			? optionsOrLabel
			: (optionsOrLabel?.label ?? displayPath);
	const summary = `Attached image: ${label} (${mimeType}, ${buf.byteLength} bytes)`;

	const g = globalThis as { emit?: (data: Record<string, unknown>, metadata?: Record<string, unknown>) => void };
	if (typeof g.emit === "function") {
		g.emit(
			{
				[mimeType]: base64Data,
				"text/plain": summary,
			},
			{
				path: displayPath,
				label,
				byte_size: buf.byteLength,
				mime_type: mimeType,
			},
		);
	} else {
		throw new AttachImageError("attach_image() must be called inside an active REPL cell.");
	}

	return {
		path: displayPath,
		mime_type: mimeType,
		mimeType,
		byte_size: buf.byteLength,
		byteSize: buf.byteLength,
		label,
	};
}

export const attachImage = attach_image;
export default attach_image;
