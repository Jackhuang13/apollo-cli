import type { Rgb } from "../../terminal-colors.js";

export type DisplayMode = "block" | "none";
export type VisibilityMode = "visible" | "hidden";
export type LayoutType = "vertical" | "horizontal" | "grid";
export type DockPosition = "top" | "bottom" | "left" | "right" | "none";
export type BorderStyle = "none" | "solid" | "round" | "heavy" | "double" | "tall" | "panel";
export type TextAlign = "left" | "center" | "right";
export type VerticalAlign = "top" | "middle" | "bottom";
export type OverflowMode = "auto" | "scroll" | "hidden";

export type BoxSpacing = [number, number, number, number]; // [top, right, bottom, left]

export type ScalarUnit = "cells" | "percent" | "fr" | "vw" | "vh" | "auto";

export interface ScalarValue {
	value: number;
	unit: ScalarUnit;
}

export type DimensionInput = number | string | ScalarValue;

export interface TextStyleFlags {
	bold?: boolean;
	dim?: boolean;
	italic?: boolean;
	underline?: boolean;
	reverse?: boolean;
	strike?: boolean;
}

export interface StyleProperties {
	display?: DisplayMode;
	visibility?: VisibilityMode;
	layout?: LayoutType;
	dock?: DockPosition;
	width?: ScalarValue;
	height?: ScalarValue;
	minWidth?: ScalarValue;
	maxWidth?: ScalarValue;
	minHeight?: ScalarValue;
	maxHeight?: ScalarValue;
	padding?: BoxSpacing;
	margin?: BoxSpacing;
	borderStyle?: BorderStyle;
	borderColor?: string;
	borderTitle?: string;
	borderSubtitle?: string;
	color?: string;
	background?: string;
	textStyle?: TextStyleFlags;
	textAlign?: TextAlign;
	contentAlignHorizontal?: TextAlign;
	contentAlignVertical?: VerticalAlign;
	overflowY?: OverflowMode;
	layer?: string;
	gridSizeColumns?: number;
	gridSizeRows?: number;
	gridGutter?: [number, number];
}

export type ThemeVariables = Record<string, string>;

export const DEFAULT_DARK_THEME: ThemeVariables = {
	$accent: "#38bdf8",
	$primary: "#3b82f6",
	$secondary: "#8b5cf6",
	$surface: "#1e293b",
	$panel: "#0f172a",
	$background: "#020617",
	$text: "#f8fafc",
	"$text-muted": "#94a3b8",
	$border: "#475569",
	$error: "#ef4444",
	$warning: "#f59e0b",
	$success: "#22c55e",
};

export const DEFAULT_LIGHT_THEME: ThemeVariables = {
	$accent: "#0284c7",
	$primary: "#2563eb",
	$secondary: "#7c3aed",
	$surface: "#f1f5f9",
	$panel: "#e2e8f0",
	$background: "#ffffff",
	$text: "#0f172a",
	"$text-muted": "#64748b",
	$border: "#94a3b8",
	$error: "#dc2626",
	$warning: "#d97706",
	$success: "#16a34a",
};

const NAMED_COLORS: Record<string, Rgb> = {
	black: { r: 0, g: 0, b: 0 },
	red: { r: 239, g: 68, b: 68 },
	green: { r: 34, g: 197, b: 94 },
	yellow: { r: 234, g: 179, b: 8 },
	blue: { r: 59, g: 130, b: 246 },
	magenta: { r: 217, g: 70, b: 239 },
	cyan: { r: 6, g: 182, b: 212 },
	white: { r: 255, g: 255, b: 255 },
	gray: { r: 148, g: 163, b: 184 },
	grey: { r: 148, g: 163, b: 184 },
	orange: { r: 249, g: 115, b: 22 },
	purple: { r: 168, g: 85, b: 247 },
	pink: { r: 236, g: 72, b: 153 },
	teal: { r: 20, g: 184, b: 166 },
};

export function parseScalar(input: DimensionInput | undefined): ScalarValue | undefined {
	if (input === undefined) return undefined;
	if (typeof input === "object" && "unit" in input) {
		return { ...input };
	}
	if (typeof input === "number") {
		return { value: input, unit: "cells" };
	}
	const str = input.trim().toLowerCase();
	if (str === "auto") {
		return { value: 0, unit: "auto" };
	}
	const frMatch = str.match(/^(-?\d+(?:\.\d+)?)fr$/);
	if (frMatch) {
		return { value: Number.parseFloat(frMatch[1]!), unit: "fr" };
	}
	const pctMatch = str.match(/^(-?\d+(?:\.\d+)?)%$/);
	if (pctMatch) {
		return { value: Number.parseFloat(pctMatch[1]!), unit: "percent" };
	}
	const vwMatch = str.match(/^(-?\d+(?:\.\d+)?)vw$/);
	if (vwMatch) {
		return { value: Number.parseFloat(vwMatch[1]!), unit: "vw" };
	}
	const vhMatch = str.match(/^(-?\d+(?:\.\d+)?)vh$/);
	if (vhMatch) {
		return { value: Number.parseFloat(vhMatch[1]!), unit: "vh" };
	}
	const numMatch = str.match(/^(-?\d+(?:\.\d+)?)(?:px|cells)?$/);
	if (numMatch) {
		return { value: Number.parseFloat(numMatch[1]!), unit: "cells" };
	}
	return undefined;
}

export function resolveScalar(
	scalar: ScalarValue | undefined,
	parentSize: number,
	viewportWidth = parentSize,
	viewportHeight = 24,
): number | undefined {
	if (!scalar || scalar.unit === "auto") return undefined;
	switch (scalar.unit) {
		case "cells":
			return Math.max(0, Math.floor(scalar.value));
		case "percent":
			return Math.max(0, Math.floor((parentSize * scalar.value) / 100));
		case "vw":
			return Math.max(0, Math.floor((viewportWidth * scalar.value) / 100));
		case "vh":
			return Math.max(0, Math.floor((viewportHeight * scalar.value) / 100));
		case "fr":
			return undefined;
	}
}

export function parseBoxSpacing(input: number | string | BoxSpacing): BoxSpacing {
	if (Array.isArray(input)) {
		return [input[0], input[1], input[2], input[3]];
	}
	if (typeof input === "number") {
		const v = Math.max(0, Math.floor(input));
		return [v, v, v, v];
	}
	const parts = input
		.trim()
		.split(/\s+/)
		.map((p) => Number.parseInt(p, 10))
		.filter((n) => !Number.isNaN(n));
	if (parts.length === 1) {
		const v = parts[0]!;
		return [v, v, v, v];
	}
	if (parts.length === 2) {
		return [parts[0]!, parts[1]!, parts[0]!, parts[1]!];
	}
	if (parts.length === 3) {
		return [parts[0]!, parts[1]!, parts[2]!, parts[1]!];
	}
	if (parts.length >= 4) {
		return [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
	}
	return [0, 0, 0, 0];
}

export function parseColorToRgb(
	colorStr: string | undefined,
	themeVars: ThemeVariables = DEFAULT_DARK_THEME,
): Rgb | null {
	if (!colorStr) return null;
	let resolved = colorStr.trim();
	if (resolved.startsWith("$")) {
		resolved = themeVars[resolved] ?? DEFAULT_DARK_THEME[resolved] ?? resolved;
	}
	const lower = resolved.toLowerCase();
	if (lower === "transparent" || lower === "none" || lower === "auto" || lower === "initial") {
		return null;
	}
	if (NAMED_COLORS[lower]) {
		return NAMED_COLORS[lower]!;
	}
	const hex6 = lower.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/);
	if (hex6) {
		return {
			r: Number.parseInt(hex6[1]!, 16),
			g: Number.parseInt(hex6[2]!, 16),
			b: Number.parseInt(hex6[3]!, 16),
		};
	}
	const hex3 = lower.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
	if (hex3) {
		return {
			r: Number.parseInt(hex3[1]! + hex3[1]!, 16),
			g: Number.parseInt(hex3[2]! + hex3[2]!, 16),
			b: Number.parseInt(hex3[3]! + hex3[3]!, 16),
		};
	}
	const rgbMatch = lower.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
	if (rgbMatch) {
		return {
			r: Math.min(255, Number.parseInt(rgbMatch[1]!, 10)),
			g: Math.min(255, Number.parseInt(rgbMatch[2]!, 10)),
			b: Math.min(255, Number.parseInt(rgbMatch[3]!, 10)),
		};
	}
	return null;
}

export function fgAnsi(colorStr: string | undefined, themeVars?: ThemeVariables): string {
	const rgb = parseColorToRgb(colorStr, themeVars);
	if (!rgb) return "";
	return `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m`;
}

export function bgAnsi(colorStr: string | undefined, themeVars?: ThemeVariables): string {
	const rgb = parseColorToRgb(colorStr, themeVars);
	if (!rgb) return "";
	return `\x1b[48;2;${rgb.r};${rgb.g};${rgb.b}m`;
}

export function textStyleAnsi(flags: TextStyleFlags | undefined): string {
	if (!flags) return "";
	const codes: number[] = [];
	if (flags.bold) codes.push(1);
	if (flags.dim) codes.push(2);
	if (flags.italic) codes.push(3);
	if (flags.underline) codes.push(4);
	if (flags.reverse) codes.push(7);
	if (flags.strike) codes.push(9);
	return codes.length > 0 ? `\x1b[${codes.join(";")}m` : "";
}

/**
 * Rich `Styles` object attached to every `DOMNode`/`Widget`.
 * Holds inline style overrides and computed cascade styles from TCSS rules.
 */
export class Styles {
	private inline: StyleProperties = {};
	private cascaded: StyleProperties = {};
	private onChange?: (layoutChanged: boolean) => void;

	constructor(onChange?: (layoutChanged: boolean) => void) {
		this.onChange = onChange;
	}

	setCascaded(props: StyleProperties): void {
		this.cascaded = { ...props };
	}

	getInline(): StyleProperties {
		return { ...this.inline };
	}

	mergeInline(props: StyleProperties): void {
		this.inline = {
			...this.inline,
			...props,
			textStyle: props.textStyle ? { ...this.inline.textStyle, ...props.textStyle } : this.inline.textStyle,
		};
		this.onChange?.(true);
	}

	private resolve<K extends keyof StyleProperties>(key: K): StyleProperties[K] {
		return this.inline[key] !== undefined ? this.inline[key] : this.cascaded[key];
	}

	get display(): DisplayMode {
		return this.resolve("display") ?? "block";
	}
	set display(val: DisplayMode) {
		this.inline.display = val;
		this.onChange?.(true);
	}

	get visibility(): VisibilityMode {
		return this.resolve("visibility") ?? "visible";
	}
	set visibility(val: VisibilityMode) {
		this.inline.visibility = val;
		this.onChange?.(false);
	}

	get layout(): LayoutType {
		return this.resolve("layout") ?? "vertical";
	}
	set layout(val: LayoutType) {
		this.inline.layout = val;
		this.onChange?.(true);
	}

	get dock(): DockPosition {
		return this.resolve("dock") ?? "none";
	}
	set dock(val: DockPosition) {
		this.inline.dock = val;
		this.onChange?.(true);
	}

	get width(): ScalarValue | undefined {
		return this.resolve("width");
	}
	set width(val: DimensionInput | undefined) {
		this.inline.width = parseScalar(val);
		this.onChange?.(true);
	}

	get height(): ScalarValue | undefined {
		return this.resolve("height");
	}
	set height(val: DimensionInput | undefined) {
		this.inline.height = parseScalar(val);
		this.onChange?.(true);
	}

	get minWidth(): ScalarValue | undefined {
		return this.resolve("minWidth");
	}
	set minWidth(val: DimensionInput | undefined) {
		this.inline.minWidth = parseScalar(val);
		this.onChange?.(true);
	}

	get maxWidth(): ScalarValue | undefined {
		return this.resolve("maxWidth");
	}
	set maxWidth(val: DimensionInput | undefined) {
		this.inline.maxWidth = parseScalar(val);
		this.onChange?.(true);
	}

	get minHeight(): ScalarValue | undefined {
		return this.resolve("minHeight");
	}
	set minHeight(val: DimensionInput | undefined) {
		this.inline.minHeight = parseScalar(val);
		this.onChange?.(true);
	}

	get maxHeight(): ScalarValue | undefined {
		return this.resolve("maxHeight");
	}
	set maxHeight(val: DimensionInput | undefined) {
		this.inline.maxHeight = parseScalar(val);
		this.onChange?.(true);
	}

	get padding(): BoxSpacing {
		return this.resolve("padding") ?? [0, 0, 0, 0];
	}
	set padding(val: number | string | BoxSpacing) {
		this.inline.padding = parseBoxSpacing(val);
		this.onChange?.(true);
	}

	get margin(): BoxSpacing {
		return this.resolve("margin") ?? [0, 0, 0, 0];
	}
	set margin(val: number | string | BoxSpacing) {
		this.inline.margin = parseBoxSpacing(val);
		this.onChange?.(true);
	}

	get borderStyle(): BorderStyle {
		return this.resolve("borderStyle") ?? "none";
	}
	set borderStyle(val: BorderStyle) {
		this.inline.borderStyle = val;
		this.onChange?.(true);
	}

	get borderColor(): string | undefined {
		return this.resolve("borderColor");
	}
	set borderColor(val: string | undefined) {
		this.inline.borderColor = val;
		this.onChange?.(false);
	}

	set border(val: BorderStyle | [BorderStyle, string] | string) {
		if (Array.isArray(val)) {
			this.inline.borderStyle = val[0];
			this.inline.borderColor = val[1];
		} else {
			const parts = val.trim().split(/\s+/);
			const stylePart = parts[0] as BorderStyle;
			this.inline.borderStyle = stylePart || "none";
			if (parts[1]) {
				this.inline.borderColor = parts[1];
			}
		}
		this.onChange?.(true);
	}
	get border(): [BorderStyle, string | undefined] {
		return [this.borderStyle, this.borderColor];
	}

	get borderTitle(): string | undefined {
		return this.resolve("borderTitle");
	}
	set borderTitle(val: string | undefined) {
		this.inline.borderTitle = val;
		this.onChange?.(false);
	}

	get borderSubtitle(): string | undefined {
		return this.resolve("borderSubtitle");
	}
	set borderSubtitle(val: string | undefined) {
		this.inline.borderSubtitle = val;
		this.onChange?.(false);
	}

	get color(): string | undefined {
		return this.resolve("color");
	}
	set color(val: string | undefined) {
		this.inline.color = val;
		this.onChange?.(false);
	}

	get background(): string | undefined {
		return this.resolve("background");
	}
	set background(val: string | undefined) {
		this.inline.background = val;
		this.onChange?.(false);
	}

	get textStyle(): TextStyleFlags {
		return { ...this.cascaded.textStyle, ...this.inline.textStyle };
	}
	set textStyle(val: TextStyleFlags | string) {
		if (typeof val === "string") {
			this.inline.textStyle = parseTextStyleString(val);
		} else {
			this.inline.textStyle = { ...val };
		}
		this.onChange?.(false);
	}

	get textAlign(): TextAlign {
		return this.resolve("textAlign") ?? this.resolve("contentAlignHorizontal") ?? "left";
	}
	set textAlign(val: TextAlign) {
		this.inline.textAlign = val;
		this.onChange?.(false);
	}

	get contentAlignHorizontal(): TextAlign {
		return this.resolve("contentAlignHorizontal") ?? this.resolve("textAlign") ?? "left";
	}
	set contentAlignHorizontal(val: TextAlign) {
		this.inline.contentAlignHorizontal = val;
		this.onChange?.(false);
	}

	get contentAlignVertical(): VerticalAlign {
		return this.resolve("contentAlignVertical") ?? "top";
	}
	set contentAlignVertical(val: VerticalAlign) {
		this.inline.contentAlignVertical = val;
		this.onChange?.(false);
	}

	get overflowY(): OverflowMode {
		return this.resolve("overflowY") ?? "auto";
	}
	set overflowY(val: OverflowMode) {
		this.inline.overflowY = val;
		this.onChange?.(true);
	}

	get layer(): string {
		return this.resolve("layer") ?? "default";
	}
	set layer(val: string) {
		this.inline.layer = val;
		this.onChange?.(true);
	}

	get gridSizeColumns(): number {
		return this.resolve("gridSizeColumns") ?? 1;
	}
	set gridSizeColumns(val: number) {
		this.inline.gridSizeColumns = Math.max(1, Math.floor(val));
		this.onChange?.(true);
	}

	get gridSizeRows(): number | undefined {
		return this.resolve("gridSizeRows");
	}
	set gridSizeRows(val: number | undefined) {
		this.inline.gridSizeRows = val !== undefined ? Math.max(1, Math.floor(val)) : undefined;
		this.onChange?.(true);
	}

	get gridGutter(): [number, number] {
		return this.resolve("gridGutter") ?? [0, 0];
	}
	set gridGutter(val: number | [number, number]) {
		if (typeof val === "number") {
			const g = Math.max(0, Math.floor(val));
			this.inline.gridGutter = [g, g];
		} else {
			this.inline.gridGutter = [Math.max(0, Math.floor(val[0])), Math.max(0, Math.floor(val[1]))];
		}
		this.onChange?.(true);
	}
}

export function parseTextStyleString(raw: string): TextStyleFlags {
	const flags: TextStyleFlags = {};
	const tokens = raw.trim().toLowerCase().split(/\s+/).filter(Boolean);
	let negateNext = false;
	for (const token of tokens) {
		if (token === "not") {
			negateNext = true;
			continue;
		}
		const val = !negateNext;
		negateNext = false;
		if (token === "none") {
			flags.bold = false;
			flags.dim = false;
			flags.italic = false;
			flags.underline = false;
			flags.reverse = false;
			flags.strike = false;
		} else if (token === "bold" || token === "b") {
			flags.bold = val;
		} else if (token === "dim" || token === "d") {
			flags.dim = val;
		} else if (token === "italic" || token === "i") {
			flags.italic = val;
		} else if (token === "underline" || token === "u") {
			flags.underline = val;
		} else if (token === "reverse" || token === "r") {
			flags.reverse = val;
		} else if (token === "strike" || token === "strikethrough" || token === "s") {
			flags.strike = val;
		}
	}
	return flags;
}
