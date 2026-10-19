import { sliceByColumn, visibleWidth } from "../utils.js";
import { resolveScalar, type ScalarValue } from "./css/styles.js";
import type { Widget } from "./widget.js";

/**
 * 2D Size in terminal cells (columns, rows).
 */
export class Size {
	public readonly width: number;
	public readonly height: number;

	constructor(width: number, height: number) {
		this.width = Math.max(0, Math.floor(width));
		this.height = Math.max(0, Math.floor(height));
	}

	equals(other: Size): boolean {
		return this.width === other.width && this.height === other.height;
	}
}

/**
 * 2D Offset in terminal cells (x, y).
 */
export class Offset {
	public readonly x: number;
	public readonly y: number;

	constructor(x: number, y: number) {
		this.x = Math.floor(x);
		this.y = Math.floor(y);
	}

	add(other: Offset): Offset {
		return new Offset(this.x + other.x, this.y + other.y);
	}
}

/**
 * Rectangular region in terminal cell coordinates.
 */
export class Region {
	public readonly x: number;
	public readonly y: number;
	public readonly width: number;
	public readonly height: number;

	constructor(x: number, y: number, width: number, height: number) {
		this.x = Math.floor(x);
		this.y = Math.floor(y);
		this.width = Math.max(0, Math.floor(width));
		this.height = Math.max(0, Math.floor(height));
	}

	get right(): number {
		return this.x + this.width;
	}

	get bottom(): number {
		return this.y + this.height;
	}

	get size(): Size {
		return new Size(this.width, this.height);
	}

	get offset(): Offset {
		return new Offset(this.x, this.y);
	}

	contains(x: number, y: number): boolean {
		return x >= this.x && x < this.right && y >= this.y && y < this.bottom;
	}

	intersection(other: Region): Region {
		const nx = Math.max(this.x, other.x);
		const ny = Math.max(this.y, other.y);
		const nr = Math.min(this.right, other.right);
		const nb = Math.min(this.bottom, other.bottom);
		return new Region(nx, ny, Math.max(0, nr - nx), Math.max(0, nb - ny));
	}
}

/**
 * A horizontal strip of terminal cells representing a single rendered row.
 */
export class Strip {
	public readonly text: string;
	public readonly cellLength: number;

	constructor(text: string, cellLength?: number) {
		this.text = text;
		this.cellLength = cellLength ?? visibleWidth(text);
	}

	crop(start: number, end: number): Strip {
		const width = Math.max(0, end - start);
		const cropped = sliceByColumn(this.text, start, width, true);
		return new Strip(cropped, visibleWidth(cropped));
	}

	pad(targetWidth: number): Strip {
		if (this.cellLength >= targetWidth) return this;
		const padded = this.text + " ".repeat(targetWidth - this.cellLength);
		return new Strip(padded, targetWidth);
	}
}

/**
 * Distribute `available` space among items with fixed/percentage/fr scalars.
 */
export function resolveFlexibleSizes(
	scalars: Array<ScalarValue | undefined>,
	intrinsicSizes: number[],
	available: number,
	viewportWidth = available,
	viewportHeight = 24,
): number[] {
	const result = new Array<number>(scalars.length).fill(0);
	let remaining = Math.max(0, available);
	let totalFr = 0;

	for (let i = 0; i < scalars.length; i++) {
		const scalar = scalars[i];
		if (!scalar || scalar.unit === "auto") {
			const size = Math.max(0, intrinsicSizes[i] ?? 0);
			result[i] = size;
			remaining = Math.max(0, remaining - size);
		} else if (scalar.unit === "fr") {
			totalFr += Math.max(0, scalar.value);
		} else {
			const resolved = resolveScalar(scalar, available, viewportWidth, viewportHeight) ?? 0;
			result[i] = resolved;
			remaining = Math.max(0, remaining - resolved);
		}
	}

	if (totalFr > 0 && remaining > 0) {
		let distributed = 0;
		let lastFrIdx = -1;
		for (let i = 0; i < scalars.length; i++) {
			const scalar = scalars[i];
			if (scalar && scalar.unit === "fr" && scalar.value > 0) {
				lastFrIdx = i;
				const share = Math.floor((remaining * scalar.value) / totalFr);
				result[i] = share;
				distributed += share;
			}
		}
		if (lastFrIdx !== -1 && distributed < remaining) {
			result[lastFrIdx]! += remaining - distributed;
		}
	}

	return result;
}

export interface DockedGroups {
	top: Widget[];
	bottom: Widget[];
	left: Widget[];
	right: Widget[];
	flow: Widget[];
}

/**
 * Partition visible children into docked (`top`, `bottom`, `left`, `right`) and normal flow widgets.
 */
export function partitionDockedChildren(children: readonly Widget[]): DockedGroups {
	const top: Widget[] = [];
	const bottom: Widget[] = [];
	const left: Widget[] = [];
	const right: Widget[] = [];
	const flow: Widget[] = [];

	for (const child of children) {
		if (child.styles.display === "none") continue;
		switch (child.styles.dock) {
			case "top":
				top.push(child);
				break;
			case "bottom":
				bottom.push(child);
				break;
			case "left":
				left.push(child);
				break;
			case "right":
				right.push(child);
				break;
			default:
				flow.push(child);
				break;
		}
	}

	return { top, bottom, left, right, flow };
}
