import { sliceByColumn, visibleWidth } from "../utils.js";
import { partitionDockedChildren, Region, resolveFlexibleSizes } from "./layout.js";
import type { Widget } from "./widget.js";

/**
 * Join multiple rendered blocks side-by-side horizontally.
 */
export function joinColumns(columns: Array<{ lines: string[]; width: number }>, totalHeight?: number): string[] {
	if (columns.length === 0) return [];
	const maxRows = totalHeight ?? Math.max(0, ...columns.map((c) => c.lines.length));
	const result: string[] = [];

	for (let r = 0; r < maxRows; r++) {
		let rowStr = "";
		for (const col of columns) {
			const line = col.lines[r] ?? "";
			const w = visibleWidth(line);
			if (w < col.width) {
				rowStr += line + " ".repeat(col.width - w);
			} else if (w > col.width) {
				rowStr += sliceByColumn(line, 0, col.width, true);
			} else {
				rowStr += line;
			}
		}
		result.push(rowStr);
	}
	return result;
}

/**
 * Compositor arranges child widgets according to `dock` (`top`, `bottom`, `left`, `right`)
 * and `layout` (`vertical`, `horizontal`, `grid`), recording each child's `Region`.
 */
// biome-ignore lint/complexity/noStaticOnlyClass: Compositor groups static layout algorithms
export class Compositor {
	/**
	 * Compose child widgets within a parent's inner content area `(width, height)`.
	 */
	static composeChildren(
		children: readonly Widget[],
		width: number,
		height: number | undefined,
		layoutType: "vertical" | "horizontal" | "grid",
		gridOptions: { columns: number; rows?: number; gutter: [number, number] },
		originX = 0,
		originY = 0,
	): string[] {
		const groups = partitionDockedChildren(children);

		const topLines: string[] = [];
		let currentY = originY;
		for (const w of groups.top) {
			const rendered = w.render(width);
			w.region = new Region(originX, currentY, width, rendered.length);
			currentY += rendered.length;
			topLines.push(...rendered);
		}

		const bottomBlocks: Array<{ widget: Widget; lines: string[] }> = [];
		let bottomTotalHeight = 0;
		for (const w of groups.bottom) {
			const rendered = w.render(width);
			bottomBlocks.push({ widget: w, lines: rendered });
			bottomTotalHeight += rendered.length;
		}

		const middleAvailHeight =
			height !== undefined ? Math.max(0, height - topLines.length - bottomTotalHeight) : undefined;

		let leftWidth = 0;
		const leftCols: Array<{ widget: Widget; width: number; lines: string[] }> = [];
		for (const w of groups.left) {
			const declaredW =
				w.styles.width && w.styles.width.unit === "cells"
					? Math.min(width - leftWidth, Math.max(1, Math.floor(w.styles.width.value)))
					: Math.min(width - leftWidth, Math.max(10, Math.floor(width / 4)));
			const rendered = w.render(declaredW, middleAvailHeight);
			leftCols.push({ widget: w, width: declaredW, lines: rendered });
			leftWidth += declaredW;
		}

		let rightWidth = 0;
		const rightCols: Array<{ widget: Widget; width: number; lines: string[] }> = [];
		for (const w of groups.right) {
			const declaredW =
				w.styles.width && w.styles.width.unit === "cells"
					? Math.min(width - leftWidth - rightWidth, Math.max(1, Math.floor(w.styles.width.value)))
					: Math.min(width - leftWidth - rightWidth, Math.max(10, Math.floor(width / 4)));
			const rendered = w.render(declaredW, middleAvailHeight);
			rightCols.push({ widget: w, width: declaredW, lines: rendered });
			rightWidth += declaredW;
		}

		const flowWidth = Math.max(1, width - leftWidth - rightWidth);
		const flowX = originX + leftWidth;
		const flowLines = Compositor.layoutFlow(
			groups.flow,
			flowWidth,
			middleAvailHeight,
			layoutType,
			gridOptions,
			flowX,
			currentY,
		);

		let middleLines: string[];
		if (leftCols.length === 0 && rightCols.length === 0) {
			middleLines = flowLines;
		} else {
			let lx = originX;
			for (const lc of leftCols) {
				lc.widget.region = new Region(lx, currentY, lc.width, lc.lines.length);
				lx += lc.width;
			}
			let rx = originX + width - rightWidth;
			for (const rc of rightCols) {
				rc.widget.region = new Region(rx, currentY, rc.width, rc.lines.length);
				rx += rc.width;
			}
			middleLines = joinColumns(
				[
					...leftCols.map((c) => ({ lines: c.lines, width: c.width })),
					{ lines: flowLines, width: flowWidth },
					...rightCols.map((c) => ({ lines: c.lines, width: c.width })),
				],
				middleAvailHeight,
			);
		}

		if (middleAvailHeight !== undefined) {
			while (middleLines.length < middleAvailHeight) {
				middleLines.push(" ".repeat(width));
			}
			if (middleLines.length > middleAvailHeight) {
				middleLines = middleLines.slice(0, middleAvailHeight);
			}
		}

		currentY += middleLines.length;
		const bottomLines: string[] = [];
		for (const b of bottomBlocks) {
			b.widget.region = new Region(originX, currentY, width, b.lines.length);
			currentY += b.lines.length;
			bottomLines.push(...b.lines);
		}

		return [...topLines, ...middleLines, ...bottomLines];
	}

	private static layoutFlow(
		widgets: Widget[],
		width: number,
		height: number | undefined,
		layoutType: "vertical" | "horizontal" | "grid",
		gridOptions: { columns: number; rows?: number; gutter: [number, number] },
		originX: number,
		originY: number,
	): string[] {
		if (widgets.length === 0) return [];

		if (layoutType === "horizontal") {
			return Compositor.layoutHorizontal(widgets, width, height, originX, originY);
		}
		if (layoutType === "grid") {
			return Compositor.layoutGrid(widgets, width, height, gridOptions, originX, originY);
		}
		return Compositor.layoutVertical(widgets, width, height, originX, originY);
	}

	private static layoutVertical(
		widgets: Widget[],
		width: number,
		height: number | undefined,
		originX: number,
		originY: number,
	): string[] {
		const hasFrHeight = height !== undefined && widgets.some((w) => w.styles.height?.unit === "fr");

		if (!hasFrHeight || height === undefined) {
			const lines: string[] = [];
			let cy = originY;
			for (const w of widgets) {
				const rendered = w.render(width);
				w.region = new Region(originX, cy, width, rendered.length);
				cy += rendered.length;
				lines.push(...rendered);
			}
			return lines;
		}

		// First pass: measure non-fr widgets
		const preRendered = new Array<string[] | null>(widgets.length).fill(null);
		const intrinsicHeights = new Array<number>(widgets.length).fill(0);
		for (let i = 0; i < widgets.length; i++) {
			const w = widgets[i]!;
			if (w.styles.height?.unit !== "fr") {
				const r = w.render(width);
				preRendered[i] = r;
				intrinsicHeights[i] = r.length;
			}
		}

		const heights = resolveFlexibleSizes(
			widgets.map((w) => w.styles.height),
			intrinsicHeights,
			height,
			width,
			height,
		);

		const lines: string[] = [];
		let cy = originY;
		for (let i = 0; i < widgets.length; i++) {
			const w = widgets[i]!;
			const targetH = heights[i]!;
			const rendered = preRendered[i] ?? w.render(width, targetH);
			w.region = new Region(originX, cy, width, rendered.length);
			cy += rendered.length;
			lines.push(...rendered);
		}
		return lines;
	}

	private static layoutHorizontal(
		widgets: Widget[],
		width: number,
		height: number | undefined,
		originX: number,
		originY: number,
	): string[] {
		const defaultShare = Math.max(1, Math.floor(width / widgets.length));
		const intrinsicWidths = widgets.map((w) => {
			if (!w.styles.width) return defaultShare;
			return defaultShare;
		});
		const scalars = widgets.map((w) => w.styles.width ?? { value: 1, unit: "fr" as const });
		const colWidths = resolveFlexibleSizes(scalars, intrinsicWidths, width, width, height ?? 24);

		const columns: Array<{ lines: string[]; width: number }> = [];
		let cx = originX;
		for (let i = 0; i < widgets.length; i++) {
			const w = widgets[i]!;
			const cw = Math.max(1, colWidths[i]!);
			const rendered = w.render(cw, height);
			w.region = new Region(cx, originY, cw, rendered.length);
			cx += cw;
			columns.push({ lines: rendered, width: cw });
		}

		return joinColumns(columns, height);
	}

	private static layoutGrid(
		widgets: Widget[],
		width: number,
		_height: number | undefined,
		gridOptions: { columns: number; rows?: number; gutter: [number, number] },
		originX: number,
		originY: number,
	): string[] {
		const cols = Math.max(1, gridOptions.columns);
		const [gutterY, gutterX] = gridOptions.gutter ?? [0, 0];
		const totalGutterX = Math.max(0, (cols - 1) * gutterX);
		const availColWidth = Math.max(1, width - totalGutterX);
		const baseColWidth = Math.max(1, Math.floor(availColWidth / cols));

		const lines: string[] = [];
		let cy = originY;

		for (let rowStart = 0; rowStart < widgets.length; rowStart += cols) {
			if (rowStart > 0 && gutterY > 0) {
				for (let g = 0; g < gutterY; g++) {
					lines.push(" ".repeat(width));
				}
				cy += gutterY;
			}

			const rowWidgets = widgets.slice(rowStart, rowStart + cols);
			const columns: Array<{ lines: string[]; width: number }> = [];
			let cx = originX;

			for (let c = 0; c < rowWidgets.length; c++) {
				if (c > 0 && gutterX > 0) {
					columns.push({ lines: [], width: gutterX });
					cx += gutterX;
				}
				const isLast = c === cols - 1;
				const cw = isLast ? Math.max(1, availColWidth - baseColWidth * (cols - 1)) : baseColWidth;
				const w = rowWidgets[c]!;
				const rendered = w.render(cw);
				w.region = new Region(cx, cy, cw, rendered.length);
				cx += cw;
				columns.push({ lines: rendered, width: cw });
			}

			const rowLines = joinColumns(columns);
			cy += rowLines.length;
			lines.push(...rowLines);
		}

		return lines;
	}
}
