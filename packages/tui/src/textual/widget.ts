import type { ClickRegion } from "../click-regions.js";
import { decodePrintableKey, parseKey } from "../keys.js";
import type { TableCellSelectionRegion } from "../selection-metadata.js";
import type { Component, Focusable } from "../tui.js";
import { sliceByColumn, truncateToWidth, visibleWidth } from "../utils.js";
import type { Binding } from "./binding.js";
import { Compositor } from "./compositor.js";
import {
	type BorderStyle,
	bgAnsi,
	DEFAULT_DARK_THEME,
	fgAnsi,
	resolveScalar,
	type TextAlign,
	textStyleAnsi,
} from "./css/styles.js";
import { DOMNode, type DOMNodeOptions } from "./dom.js";
import { Region } from "./layout.js";
import { BlurEvent, ClickEvent, FocusEvent, KeyEvent, MountEvent, UnmountEvent } from "./messages.js";
import { initializeReactives } from "./reactive.js";

export interface WidgetOptions extends DOMNodeOptions {
	name?: string;
}

interface BorderChars {
	tl: string;
	tr: string;
	bl: string;
	br: string;
	h: string;
	v: string;
}

const BORDER_CHAR_MAP: Record<Exclude<BorderStyle, "none">, BorderChars> = {
	solid: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
	round: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
	heavy: { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃" },
	double: { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" },
	tall: { tl: "▊", tr: "▎", bl: "▊", br: "▎", h: "▔", v: "▊" },
	panel: { tl: "┏", tr: "┓", bl: "└", br: "┘", h: "━", v: "│" },
};

function alignLine(line: string, width: number, align: TextAlign): string {
	const vis = visibleWidth(line);
	if (vis > width) {
		return sliceByColumn(line, 0, width, true);
	}
	if (vis === width) {
		return line;
	}
	const extra = width - vis;
	if (align === "center") {
		const left = Math.floor(extra / 2);
		const right = extra - left;
		return " ".repeat(left) + line + " ".repeat(right);
	}
	if (align === "right") {
		return " ".repeat(extra) + line;
	}
	return line + " ".repeat(extra);
}

/**
 * Base class for all Textual widgets.
 * Implements `Component` and `Focusable` from `../tui.js` so any `Widget` can be used
 * directly inside `TUI`, `Container`, or `Screen`.
 */
export class Widget extends DOMNode implements Component, Focusable {
	public static BINDINGS: Binding[] = [];
	public static DEFAULT_CSS = "";

	public name: string | undefined;
	public canFocus = false;
	public region: Region = new Region(0, 0, 0, 0);
	public isMounted = false;
	private _focused = false;
	private _composed = false;
	protected clickRegions: ClickRegion[] = [];
	protected selectionRegions: TableCellSelectionRegion[] = [];

	constructor(options?: WidgetOptions) {
		super(options);
		this.name = options?.name;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(val: boolean) {
		if (this._focused === val) return;
		this._focused = val;
		this.refreshStyles();
		if (val) {
			this.dispatchMessageSync(new FocusEvent(this));
		} else {
			this.dispatchMessageSync(new BlurEvent(this));
		}
		this.refresh({ layout: false, repaint: true });
	}

	get borderTitle(): string | undefined {
		return this.styles.borderTitle;
	}

	set borderTitle(val: string | undefined) {
		this.styles.borderTitle = val;
	}

	get borderSubtitle(): string | undefined {
		return this.styles.borderSubtitle;
	}

	set borderSubtitle(val: string | undefined) {
		this.styles.borderSubtitle = val;
	}

	/**
	 * Focus this widget on the active screen.
	 */
	focus(): this {
		if (!this.canFocus || this.disabled) return this;
		const scr = this.screen;
		if (scr) {
			scr.setFocus(this);
		} else {
			this.focused = true;
		}
		return this;
	}

	/**
	 * Remove focus from this widget.
	 */
	blur(): this {
		if (!this._focused) return this;
		const scr = this.screen;
		if (scr && scr.focusedWidget === this) {
			scr.setFocus(null);
		} else {
			this.focused = false;
		}
		return this;
	}

	/**
	 * Override in subclasses to yield child widgets declaratively.
	 */
	compose(): Iterable<Widget> {
		return [];
	}

	/**
	 * Lifecycle hook called when widget is mounted into the DOM.
	 */
	protected onMount(): void {}

	/**
	 * Lifecycle hook called when widget is unmounted from the DOM.
	 */
	protected onUnmount(): void {}

	/**
	 * Ensure declarative children from `compose()` and reactive properties are initialized.
	 */
	public ensureComposed(): void {
		if (this._composed) return;
		this._composed = true;
		initializeReactives(this);

		const ctor = this.constructor as typeof Widget;
		if (ctor.DEFAULT_CSS && this.app) {
			this.app.registerWidgetCss(ctor.name, ctor.DEFAULT_CSS);
		}

		for (const child of this.compose()) {
			this.attachChild(child);
		}
	}

	private attachChild(child: Widget, beforeIndex?: number): void {
		if (child.parent && child.parent !== this) {
			child.remove();
		}
		child.parent = this;
		if (beforeIndex !== undefined && beforeIndex >= 0 && beforeIndex <= this.children.length) {
			this.children.splice(beforeIndex, 0, child);
		} else {
			this.children.push(child);
		}
		child.ensureComposed();
		if (this.isMounted) {
			child.triggerMount();
		}
	}

	public triggerMount(): void {
		if (this.isMounted) return;
		this.ensureComposed();
		this.isMounted = true;
		this.refreshStyles();
		this.onMount();
		this.dispatchMessageSync(new MountEvent(this));
		for (const child of this.children) {
			child.triggerMount();
		}
	}

	public triggerUnmount(): void {
		if (!this.isMounted) return;
		for (const child of this.children) {
			child.triggerUnmount();
		}
		this.isMounted = false;
		if (this._focused) {
			this.blur();
		}
		this.onUnmount();
		this.dispatchMessageSync(new UnmountEvent(this));
	}

	/**
	 * Mount one or more child widgets into this widget.
	 */
	mount(...widgets: Widget[]): this {
		this.ensureComposed();
		for (const w of widgets) {
			this.attachChild(w);
		}
		this.refreshStyles();
		this.refresh({ layout: true, repaint: true });
		return this;
	}

	/**
	 * Mount a widget immediately before an existing child widget (or index).
	 */
	mountBefore(widget: Widget, before: Widget | number): this {
		this.ensureComposed();
		const index = typeof before === "number" ? before : this.children.indexOf(before);
		this.attachChild(widget, index === -1 ? undefined : index);
		this.refreshStyles();
		this.refresh({ layout: true, repaint: true });
		return this;
	}

	/**
	 * Remove this widget from its parent.
	 */
	remove(): void {
		if (!this.parent) return;
		const idx = this.parent.children.indexOf(this);
		if (idx !== -1) {
			this.parent.children.splice(idx, 1);
		}
		const oldParent = this.parent;
		this.triggerUnmount();
		this.parent = null;
		oldParent.refresh({ layout: true, repaint: true });
	}

	/**
	 * Remove all children from this widget.
	 */
	removeChildren(): this {
		const copy = [...this.children];
		for (const child of copy) {
			child.remove();
		}
		return this;
	}

	invalidate(): void {
		for (const child of this.children) {
			child.invalidate();
		}
	}

	getClickRegions(): ReadonlyArray<ClickRegion> {
		return this.clickRegions;
	}

	getSelectionRegions(): ReadonlyArray<TableCellSelectionRegion> {
		return this.selectionRegions;
	}

	/**
	 * Handle raw terminal input on this widget.
	 * Dispatches a `KeyEvent`, checks `BINDINGS`, and triggers `action_<name>()` if not prevented.
	 */
	handleInput(data: string): void {
		if (this.disabled) return;

		const parsedKey = parseKey(data) ?? data;
		const printable = decodePrintableKey(data) ?? (data.length === 1 && data.charCodeAt(0) >= 32 ? data : undefined);
		const keyEvent = new KeyEvent(parsedKey, data, printable, this);
		this.dispatchMessageSync(keyEvent);

		if (keyEvent.defaultPrevented || keyEvent.stopped) {
			return;
		}

		if (this.checkAndRunBindings(data)) {
			return;
		}
	}

	/**
	 * Check widget/screen/app `BINDINGS` on this node and its ancestors.
	 */
	public checkAndRunBindings(rawData: string, priorityOnly = false): boolean {
		let curr: DOMNode | null = this;
		while (curr) {
			const ctor = curr.constructor as { BINDINGS?: Binding[] };
			const bindings = ctor.BINDINGS ?? [];
			for (const b of bindings) {
				if (priorityOnly && !b.priority) continue;
				if (b.matches(rawData)) {
					if (this.invokeActionOnChain(curr, b.action)) {
						return true;
					}
				}
			}
			curr = curr.parent;
		}
		return false;
	}

	protected invokeActionOnChain(startNode: DOMNode, actionSpec: string): boolean {
		const parenIdx = actionSpec.indexOf("(");
		let actionName = actionSpec;
		let args: string[] = [];
		if (parenIdx !== -1 && actionSpec.endsWith(")")) {
			actionName = actionSpec.slice(0, parenIdx).trim();
			const rawArgs = actionSpec.slice(parenIdx + 1, -1).trim();
			if (rawArgs) {
				args = rawArgs.split(",").map((a) => a.trim().replace(/^['"]|['"]$/g, ""));
			}
		}

		const camel = actionName.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
		const methodCandidates = [`action_${actionName}`, `action${camel.charAt(0).toUpperCase() + camel.slice(1)}`];

		let curr: DOMNode | null = startNode;
		while (curr) {
			const rec = curr as unknown as Record<string, unknown>;
			for (const methodName of methodCandidates) {
				const fn = rec[methodName];
				if (typeof fn === "function") {
					void (fn as (...a: string[]) => unknown).apply(curr, args);
					this.refresh({ layout: true, repaint: true });
					return true;
				}
			}
			curr = curr.parent;
		}
		return false;
	}

	/**
	 * Subclasses override `renderContent` to render their inner content lines.
	 * Default implementation composes child widgets according to `styles.layout`.
	 */
	protected renderContent(contentWidth: number, contentHeight?: number): string[] {
		if (this.children.length === 0) {
			return [];
		}
		return Compositor.composeChildren(
			this.children,
			contentWidth,
			contentHeight,
			this.styles.layout,
			{
				columns: this.styles.gridSizeColumns,
				rows: this.styles.gridSizeRows,
				gutter: this.styles.gridGutter,
			},
			0,
			0,
		);
	}

	/**
	 * Render this widget to an array of terminal lines for the given `availableWidth` (and optional `availableHeight`).
	 * Applies TCSS `display`, `visibility`, `margin`, `border`, `padding`, `background`, `color`, `textStyle`, and `textAlign`.
	 */
	render(availableWidth: number, availableHeight?: number): string[] {
		this.ensureComposed();
		this.clickRegions = [];
		this.selectionRegions = [];

		if (this.styles.display === "none" || availableWidth <= 0) {
			this.region = new Region(this.region.x, this.region.y, 0, 0);
			return [];
		}

		const viewportW = this.app?.terminal.columns ?? availableWidth;
		const viewportH = this.app?.terminal.rows ?? availableHeight ?? 24;
		const themeVars = this.app?.stylesheet.getVariables() ?? DEFAULT_DARK_THEME;

		const [marginTop, marginRight, marginBottom, marginLeft] = this.styles.margin;
		const [padTop, padRight, padBottom, padLeft] = this.styles.padding;
		const borderStyle = this.styles.borderStyle;
		const hasBorder = borderStyle !== "none";
		const borderSize = hasBorder ? 1 : 0;

		const outerMaxW = Math.max(1, availableWidth - marginLeft - marginRight);
		let boxWidth = resolveScalar(this.styles.width, outerMaxW, viewportW, viewportH) ?? outerMaxW;
		const minW = resolveScalar(this.styles.minWidth, outerMaxW, viewportW, viewportH);
		const maxW = resolveScalar(this.styles.maxWidth, outerMaxW, viewportW, viewportH);
		if (minW !== undefined) boxWidth = Math.max(boxWidth, minW);
		if (maxW !== undefined) boxWidth = Math.min(boxWidth, maxW);
		boxWidth = Math.max(1, Math.min(boxWidth, outerMaxW));

		let boxHeight: number | undefined;
		if (availableHeight !== undefined) {
			boxHeight = Math.max(0, availableHeight - marginTop - marginBottom);
		}
		const explicitH = resolveScalar(this.styles.height, availableHeight ?? viewportH, viewportW, viewportH);
		if (explicitH !== undefined) {
			boxHeight = explicitH;
		}
		const minH = resolveScalar(this.styles.minHeight, availableHeight ?? viewportH, viewportW, viewportH);
		const maxH = resolveScalar(this.styles.maxHeight, availableHeight ?? viewportH, viewportW, viewportH);

		const horizontalChrome = borderSize + padLeft + (borderSize + padRight);
		const verticalChrome = borderSize + padTop + (borderSize + padBottom);
		const contentWidth = Math.max(1, boxWidth - horizontalChrome);
		const targetContentHeight = boxHeight !== undefined ? Math.max(0, boxHeight - verticalChrome) : undefined;

		let contentLines = this.renderContent(contentWidth, targetContentHeight);

		// Apply minHeight / maxHeight / explicit boxHeight to contentLines
		let desiredInnerHeight = contentLines.length;
		if (targetContentHeight !== undefined) {
			desiredInnerHeight = targetContentHeight;
		}
		if (minH !== undefined) {
			desiredInnerHeight = Math.max(desiredInnerHeight, Math.max(0, minH - verticalChrome));
		}
		if (maxH !== undefined) {
			desiredInnerHeight = Math.min(desiredInnerHeight, Math.max(0, maxH - verticalChrome));
		}

		// Vertical alignment / clipping inside content box
		if (contentLines.length > desiredInnerHeight) {
			contentLines = contentLines.slice(0, desiredInnerHeight);
		} else if (contentLines.length < desiredInnerHeight) {
			const extraRows = desiredInnerHeight - contentLines.length;
			const vAlign = this.styles.contentAlignVertical;
			const topEmpty = vAlign === "middle" ? Math.floor(extraRows / 2) : vAlign === "bottom" ? extraRows : 0;
			const bottomEmpty = extraRows - topEmpty;
			contentLines = [
				...new Array<string>(topEmpty).fill(""),
				...contentLines,
				...new Array<string>(bottomEmpty).fill(""),
			];
		}

		if (this.styles.visibility === "hidden") {
			const totalRows = marginTop + verticalChrome + contentLines.length + marginBottom;
			return new Array<string>(totalRows).fill(" ".repeat(availableWidth));
		}

		const fgCode = fgAnsi(this.styles.color, themeVars);
		const bgCode = bgAnsi(this.styles.background, themeVars);
		const styleCode = textStyleAnsi(this.styles.textStyle);
		const borderFgCode = fgAnsi(this.styles.borderColor ?? "$border", themeVars);
		const hasInnerSgr = Boolean(fgCode || bgCode || styleCode);
		const innerPrefix = `${bgCode}${fgCode}${styleCode}`;
		const innerSuffix = hasInnerSgr ? "\x1b[0m" : "";

		const align = this.styles.textAlign;
		const leftPadStr = " ".repeat(padLeft);
		const rightPadStr = " ".repeat(padRight);
		const innerBoxWidth = Math.max(1, boxWidth - borderSize * 2);

		const formatInnerRow = (rawLine: string): string => {
			const aligned = alignLine(rawLine, contentWidth, align);
			const rowWithPad = sliceByColumn(leftPadStr + aligned + rightPadStr, 0, innerBoxWidth, true);
			const vis = visibleWidth(rowWithPad);
			const padded = vis < innerBoxWidth ? rowWithPad + " ".repeat(innerBoxWidth - vis) : rowWithPad;
			if (!hasInnerSgr) return padded;
			// Re-apply innerPrefix after any internal \x1b[0m resets so background/color fills entire widget box
			const restored = padded.replace(/\x1b\[0m/g, `\x1b[0m${innerPrefix}`);
			return `${innerPrefix}${restored}${innerSuffix}`;
		};

		const boxLines: string[] = [];
		const chars = hasBorder ? BORDER_CHAR_MAP[borderStyle] : null;

		if (chars) {
			boxLines.push(
				this.renderBorderBar(chars.tl, chars.h, chars.tr, boxWidth, this.borderTitle, borderFgCode, bgCode),
			);
		}

		for (let i = 0; i < padTop; i++) {
			const inner = formatInnerRow("");
			boxLines.push(chars ? this.wrapWithVerticalBorder(chars.v, inner, borderFgCode, bgCode) : inner);
		}

		for (const rawLine of contentLines) {
			const inner = formatInnerRow(rawLine);
			boxLines.push(chars ? this.wrapWithVerticalBorder(chars.v, inner, borderFgCode, bgCode) : inner);
		}

		for (let i = 0; i < padBottom; i++) {
			const inner = formatInnerRow("");
			boxLines.push(chars ? this.wrapWithVerticalBorder(chars.v, inner, borderFgCode, bgCode) : inner);
		}

		if (chars) {
			boxLines.push(
				this.renderBorderBar(chars.bl, chars.h, chars.br, boxWidth, this.borderSubtitle, borderFgCode, bgCode),
			);
		}

		// Apply outer margins
		const finalLines: string[] = [];
		const marginLeftStr = " ".repeat(marginLeft);
		const marginRightStr = " ".repeat(marginRight);

		for (let i = 0; i < marginTop; i++) {
			finalLines.push("");
		}
		for (const bl of boxLines) {
			finalLines.push(marginLeftStr + bl + marginRightStr);
		}
		for (let i = 0; i < marginBottom; i++) {
			finalLines.push("");
		}

		// Record click region for this widget so TUI mouse clicks dispatch `ClickEvent`
		const clickHeight = boxLines.length;
		if (clickHeight > 0) {
			this.clickRegions.push({
				line: marginTop,
				col: marginLeft,
				width: boxWidth,
				height: clickHeight,
				onClick: (pos) => {
					if (this.disabled) return;
					if (this.canFocus) {
						this.focus();
					}
					this.dispatchMessageSync(new ClickEvent(pos.col, pos.row, {}, this));
				},
			});
		}

		// Aggregate child click regions offset by this widget's chrome
		const childOffsetY = marginTop + borderSize + padTop;
		const childOffsetX = marginLeft + borderSize + padLeft;
		for (const child of this.children) {
			if (child.styles.display === "none") continue;
			for (const cr of child.getClickRegions()) {
				this.clickRegions.push({
					line: childOffsetY + child.region.y + cr.line,
					col: childOffsetX + child.region.x + cr.col,
					width: cr.width,
					height: cr.height,
					onClick: cr.onClick,
				});
			}
		}

		this.region = new Region(this.region.x, this.region.y, boxWidth, finalLines.length);
		return finalLines;
	}

	private wrapWithVerticalBorder(vChar: string, inner: string, borderFg: string, bgCode: string): string {
		const bStart = `${bgCode}${borderFg}`;
		const bEnd = borderFg || bgCode ? "\x1b[0m" : "";
		return `${bStart}${vChar}${bEnd}${inner}${bStart}${vChar}${bEnd}`;
	}

	private renderBorderBar(
		leftCorner: string,
		horizChar: string,
		rightCorner: string,
		totalWidth: number,
		title: string | undefined,
		borderFg: string,
		bgCode: string,
	): string {
		if (totalWidth <= 1) return leftCorner;
		const innerSpan = Math.max(0, totalWidth - 2);
		let barInner: string;
		if (title && innerSpan >= 4) {
			const cleanTitle = ` ${truncateToWidth(title, innerSpan - 2, "…")} `;
			const tWidth = visibleWidth(cleanTitle);
			const remaining = Math.max(0, innerSpan - tWidth);
			const leftH = Math.min(1, remaining);
			const rightH = Math.max(0, remaining - leftH);
			barInner = horizChar.repeat(leftH) + cleanTitle + horizChar.repeat(rightH);
		} else {
			barInner = horizChar.repeat(innerSpan);
		}
		const bStart = `${bgCode}${borderFg}`;
		const bEnd = borderFg || bgCode ? "\x1b[0m" : "";
		return `${bStart}${leftCorner}${barInner}${rightCorner}${bEnd}`;
	}
}
