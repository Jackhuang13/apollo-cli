import { Editor, type EditorOptions, type EditorTheme } from "../../components/editor.js";
import { Input, type InputOptions } from "../../components/input.js";
import { Loader, type LoaderIndicatorOptions } from "../../components/loader.js";
import { Markdown, type MarkdownOptions, type MarkdownTheme } from "../../components/markdown.js";
import {
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type SelectListTheme,
} from "../../components/select-list.js";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../../utils.js";
import { Binding } from "../binding.js";
import { InputChanged, InputSubmitted, OptionSelected, TabActivated } from "../messages.js";
import { defineReactive } from "../reactive.js";
import { Widget, type WidgetOptions } from "../widget.js";

/**
 * Static text/content widget (also base for containers and labels).
 */
export class Static extends Widget {
	public declare content: string;

	constructor(content = "", options?: WidgetOptions) {
		super(options);
		defineReactive(this, "content", content, { layout: true, repaint: true });
	}

	update(content: string): this {
		this.content = content;
		return this;
	}

	protected override renderContent(contentWidth: number, contentHeight?: number): string[] {
		if (this.children.length > 0) {
			return super.renderContent(contentWidth, contentHeight);
		}
		if (!this.content) {
			return [];
		}
		return wrapTextWithAnsi(this.content, Math.max(1, contentWidth));
	}
}

/**
 * Label widget for displaying single or wrapped text labels.
 */
export class Label extends Static {}

/**
 * Vertical layout container (`layout: vertical`).
 */
export class Vertical extends Widget {
	constructor(...childrenOrOptions: Array<Widget | WidgetOptions>) {
		const last = childrenOrOptions[childrenOrOptions.length - 1];
		const hasOptions = last !== undefined && !(last instanceof Widget);
		super(hasOptions ? (last as WidgetOptions) : undefined);
		this.styles.layout = "vertical";
		for (const item of childrenOrOptions) {
			if (item instanceof Widget) {
				this.mount(item);
			}
		}
	}
}

/**
 * Horizontal layout container (`layout: horizontal`).
 */
export class Horizontal extends Widget {
	constructor(...childrenOrOptions: Array<Widget | WidgetOptions>) {
		const last = childrenOrOptions[childrenOrOptions.length - 1];
		const hasOptions = last !== undefined && !(last instanceof Widget);
		super(hasOptions ? (last as WidgetOptions) : undefined);
		this.styles.layout = "horizontal";
		for (const item of childrenOrOptions) {
			if (item instanceof Widget) {
				this.mount(item);
			}
		}
	}
}

/**
 * Grid layout container (`layout: grid`).
 */
export class Grid extends Widget {
	constructor(
		...childrenOrOptions: Array<
			Widget | (WidgetOptions & { columns?: number; rows?: number; gutter?: number | [number, number] })
		>
	) {
		const last = childrenOrOptions[childrenOrOptions.length - 1];
		const hasOptions = last !== undefined && !(last instanceof Widget);
		const opts = hasOptions
			? (last as WidgetOptions & { columns?: number; rows?: number; gutter?: number | [number, number] })
			: undefined;
		super(opts);
		this.styles.layout = "grid";
		if (opts?.columns !== undefined) {
			this.styles.gridSizeColumns = opts.columns;
		}
		if (opts?.rows !== undefined) {
			this.styles.gridSizeRows = opts.rows;
		}
		if (opts?.gutter !== undefined) {
			this.styles.gridGutter = opts.gutter;
		}
		for (const item of childrenOrOptions) {
			if (item instanceof Widget) {
				this.mount(item);
			}
		}
	}
}

/**
 * Scrollable container widget with vertical scroll offset and keyboard/wheel navigation.
 */
export class ScrollableContainer extends Widget {
	public static override BINDINGS: Binding[] = [
		new Binding("up", "scroll_up", "Scroll Up", { show: false }),
		new Binding("down", "scroll_down", "Scroll Down", { show: false }),
		new Binding("pageUp", "page_up", "Page Up", { show: false }),
		new Binding("pageDown", "page_down", "Page Down", { show: false }),
		new Binding("home", "scroll_home", "Scroll Home", { show: false }),
		new Binding("end", "scroll_end", "Scroll End", { show: false }),
	];

	public declare scrollY: number;
	private _maxScrollY = 0;
	private _lastViewportHeight = 10;

	constructor(...childrenOrOptions: Array<Widget | WidgetOptions>) {
		const last = childrenOrOptions[childrenOrOptions.length - 1];
		const hasOptions = last !== undefined && !(last instanceof Widget);
		super(hasOptions ? (last as WidgetOptions) : undefined);
		this.canFocus = true;
		this.styles.overflowY = "scroll";
		defineReactive(this, "scrollY", 0, { layout: false, repaint: true });
		for (const item of childrenOrOptions) {
			if (item instanceof Widget) {
				this.mount(item);
			}
		}
	}

	get maxScrollY(): number {
		return this._maxScrollY;
	}

	scrollTo(y: number): void {
		const target = Math.max(0, y);
		this.scrollY = this._maxScrollY > 0 ? Math.min(target, this._maxScrollY) : target;
	}

	scrollBy(deltaY: number): void {
		this.scrollTo(this.scrollY + deltaY);
	}

	public action_scroll_up(): void {
		this.scrollBy(-1);
	}

	public action_scroll_down(): void {
		this.scrollBy(1);
	}

	public action_page_up(): void {
		this.scrollBy(-Math.max(1, this._lastViewportHeight - 1));
	}

	public action_page_down(): void {
		this.scrollBy(Math.max(1, this._lastViewportHeight - 1));
	}

	public action_scroll_home(): void {
		this.scrollTo(0);
	}

	public action_scroll_end(): void {
		this.scrollTo(this._maxScrollY);
	}

	protected override renderContent(contentWidth: number, contentHeight?: number): string[] {
		const fullLines = super.renderContent(contentWidth, undefined);
		if (contentHeight === undefined || fullLines.length <= contentHeight) {
			this._maxScrollY = 0;
			this._lastViewportHeight = contentHeight ?? fullLines.length;
			return fullLines;
		}
		this._lastViewportHeight = contentHeight;
		this._maxScrollY = Math.max(0, fullLines.length - contentHeight);
		const clampedY = Math.max(0, Math.min(this.scrollY, this._maxScrollY));
		return fullLines.slice(clampedY, clampedY + contentHeight);
	}
}

export class VerticalScroll extends ScrollableContainer {}

/**
 * Top application header bar displaying `app.title` and `app.subTitle`.
 */
export class Header extends Widget {
	public declare showClock: boolean;

	constructor(options?: WidgetOptions & { showClock?: boolean }) {
		super(options);
		this.styles.dock = "top";
		this.styles.height = 1;
		this.styles.background = "$surface";
		this.styles.color = "$text";
		defineReactive(this, "showClock", options?.showClock ?? false, { layout: false, repaint: true });
	}

	protected override renderContent(contentWidth: number): string[] {
		const title = this.app?.title ?? "Textual App";
		const sub = this.app?.subTitle ? ` — ${this.app.subTitle}` : "";
		const fullTitle = `${title}${sub}`;
		if (!this.showClock) {
			const vis = visibleWidth(fullTitle);
			const leftPad = Math.max(0, Math.floor((contentWidth - vis) / 2));
			const line = " ".repeat(leftPad) + fullTitle;
			return [truncateToWidth(line, contentWidth, "…", true)];
		}
		const now = new Date();
		const clock = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
		const avail = Math.max(1, contentWidth - clock.length - 1);
		const left = truncateToWidth(` ${fullTitle}`, avail, "…", true);
		return [`${left} ${clock}`];
	}
}

/**
 * Bottom application footer displaying active keybindings from the focused widget, screen, and app.
 */
export class Footer extends Widget {
	constructor(options?: WidgetOptions) {
		super(options);
		this.styles.dock = "bottom";
		this.styles.height = 1;
		this.styles.background = "$panel";
		this.styles.color = "$text";
	}

	protected override renderContent(contentWidth: number): string[] {
		const bindings = this.collectActiveBindings();
		if (bindings.length === 0) {
			return [" ".repeat(contentWidth)];
		}
		const parts: string[] = [];
		for (const b of bindings) {
			const keyText = `\x1b[1;36m ${b.getDisplayKey()} \x1b[0m`;
			const descText = `${b.description || b.action}`;
			parts.push(`${keyText}${descText}`);
		}
		const joined = parts.join("  ");
		return [truncateToWidth(joined, contentWidth, "…", true)];
	}

	private collectActiveBindings(): Binding[] {
		const result: Binding[] = [];
		const seenActions = new Set<string>();
		const activeScreen = this.screen ?? this.app?.screen ?? null;
		const chain: Array<{ constructor: unknown }> = [];
		if (activeScreen?.focusedWidget) {
			chain.push(activeScreen.focusedWidget);
		}
		if (activeScreen) {
			chain.push(activeScreen);
		}
		if (this.app) {
			chain.push(this.app);
		}
		for (const node of chain) {
			const ctor = node.constructor as { BINDINGS?: Binding[] };
			for (const b of ctor.BINDINGS ?? []) {
				if (!b.show) continue;
				if (!seenActions.has(b.action)) {
					seenActions.add(b.action);
					result.push(b);
				}
			}
		}
		return result;
	}
}

export type RuleLineStyle = "solid" | "double" | "dashed" | "heavy";

/**
 * Horizontal or vertical divider line (`Rule`).
 */
export class Rule extends Widget {
	public orientation: "horizontal" | "vertical";
	public lineStyle: RuleLineStyle;

	constructor(options?: WidgetOptions & { orientation?: "horizontal" | "vertical"; lineStyle?: RuleLineStyle }) {
		super(options);
		this.orientation = options?.orientation ?? "horizontal";
		this.lineStyle = options?.lineStyle ?? "solid";
		if (this.orientation === "horizontal") {
			this.styles.height = 1;
		} else {
			this.styles.width = 1;
		}
	}

	protected override renderContent(contentWidth: number, contentHeight?: number): string[] {
		const charMap: Record<RuleLineStyle, { h: string; v: string }> = {
			solid: { h: "─", v: "│" },
			double: { h: "═", v: "║" },
			dashed: { h: "╌", v: "╎" },
			heavy: { h: "━", v: "┃" },
		};
		const chars = charMap[this.lineStyle];
		if (this.orientation === "vertical") {
			const rows = Math.max(1, contentHeight ?? 1);
			return new Array<string>(rows).fill(chars.v);
		}
		return [chars.h.repeat(Math.max(1, contentWidth))];
	}
}

/**
 * Expandable/collapsible container with a clickable/focusable title header.
 */
export class Collapsible extends Widget {
	public static override BINDINGS: Binding[] = [
		new Binding("enter,space", "toggle_collapsed", "Toggle", { show: false }),
	];

	public declare title: string;
	public declare collapsed: boolean;

	constructor(title: string, ...childrenOrOptions: Array<Widget | (WidgetOptions & { collapsed?: boolean })>) {
		const last = childrenOrOptions[childrenOrOptions.length - 1];
		const hasOptions = last !== undefined && !(last instanceof Widget);
		const opts = hasOptions ? (last as WidgetOptions & { collapsed?: boolean }) : undefined;
		super(opts);
		this.canFocus = true;
		defineReactive(this, "title", title, { layout: false, repaint: true });
		defineReactive(this, "collapsed", opts?.collapsed ?? true, { layout: true, repaint: true });
		for (const item of childrenOrOptions) {
			if (item instanceof Widget) {
				this.mount(item);
			}
		}
	}

	public action_toggle_collapsed(): void {
		this.collapsed = !this.collapsed;
	}

	protected override renderContent(contentWidth: number, contentHeight?: number): string[] {
		const arrow = this.collapsed ? "▶" : "▼";
		const headerLine = truncateToWidth(`${arrow} ${this.title}`, contentWidth, "…", true);
		if (this.collapsed) {
			return [headerLine];
		}
		const childLines = super.renderContent(
			contentWidth,
			contentHeight !== undefined ? Math.max(0, contentHeight - 1) : undefined,
		);
		return [headerLine, ...childLines];
	}
}

/**
 * Individual pane inside a `TabbedContent` container.
 */
export class TabPane extends Widget {
	public title: string;

	constructor(title: string, ...childrenOrOptions: Array<Widget | WidgetOptions>) {
		const last = childrenOrOptions[childrenOrOptions.length - 1];
		const hasOptions = last !== undefined && !(last instanceof Widget);
		super(hasOptions ? (last as WidgetOptions) : undefined);
		this.title = title;
		for (const item of childrenOrOptions) {
			if (item instanceof Widget) {
				this.mount(item);
			}
		}
	}
}

/**
 * Tabbed container switching between child `TabPane` widgets.
 */
export class TabbedContent extends Widget {
	public static override BINDINGS: Binding[] = [
		new Binding("left", "previous_tab", "Prev Tab", { show: false }),
		new Binding("right", "next_tab", "Next Tab", { show: false }),
	];

	public declare active: string;

	constructor(...panesOrOptions: Array<TabPane | (WidgetOptions & { initial?: string })>) {
		const last = panesOrOptions[panesOrOptions.length - 1];
		const hasOptions = last !== undefined && !(last instanceof TabPane);
		const opts = hasOptions ? (last as WidgetOptions & { initial?: string }) : undefined;
		super(opts);
		this.canFocus = true;

		const panes = panesOrOptions.filter((p): p is TabPane => p instanceof TabPane);
		const firstId = opts?.initial ?? panes[0]?.id ?? "tab-0";
		defineReactive(this, "active", firstId, { layout: true, repaint: true });

		for (let i = 0; i < panes.length; i++) {
			const pane = panes[i]!;
			if (!pane.id) {
				pane.id = `tab-${i}`;
			}
			this.mount(pane);
		}
	}

	get panes(): TabPane[] {
		return this.children.filter((c): c is TabPane => c instanceof TabPane);
	}

	public action_next_tab(): void {
		const panes = this.panes;
		if (panes.length === 0) return;
		const idx = panes.findIndex((p) => p.id === this.active);
		const next = panes[(idx + 1) % panes.length]!;
		this.activateTab(next);
	}

	public action_previous_tab(): void {
		const panes = this.panes;
		if (panes.length === 0) return;
		const idx = Math.max(
			0,
			panes.findIndex((p) => p.id === this.active),
		);
		const prev = panes[(idx - 1 + panes.length) % panes.length]!;
		this.activateTab(prev);
	}

	public activateTab(paneOrId: TabPane | string): void {
		const panes = this.panes;
		const target = typeof paneOrId === "string" ? panes.find((p) => p.id === paneOrId) : paneOrId;
		if (!target || !target.id) return;
		this.active = target.id;
		this.postMessage(new TabActivated(target.id, target.title, this));
	}

	protected override renderContent(contentWidth: number, contentHeight?: number): string[] {
		const panes = this.panes;
		if (panes.length === 0) return [];

		const activePane = panes.find((p) => p.id === this.active) ?? panes[0]!;
		const tabHeaders = panes.map((p) => {
			const isCurrent = p === activePane;
			return isCurrent ? `\x1b[1;4m ${p.title} \x1b[0m` : ` ${p.title} `;
		});
		const barLine = truncateToWidth(tabHeaders.join("│"), contentWidth, "…", true);
		const divider = "─".repeat(Math.max(1, contentWidth));

		const bodyHeight = contentHeight !== undefined ? Math.max(0, contentHeight - 2) : undefined;
		const bodyLines = activePane.render(contentWidth, bodyHeight);
		return [barLine, divider, ...bodyLines];
	}
}

const DEFAULT_SELECT_THEME: SelectListTheme = {
	selectedPrefix: (t) => `\x1b[36m${t}\x1b[0m`,
	selectedText: (t) => `\x1b[1;36m${t}\x1b[0m`,
	description: (t) => `\x1b[2m${t}\x1b[0m`,
	scrollInfo: (t) => `\x1b[2m${t}\x1b[0m`,
	noMatch: (t) => `\x1b[2m${t}\x1b[0m`,
};

/**
 * OptionList widget wrapping `SelectList` and emitting `OptionSelected` messages.
 */
export class OptionList extends Widget {
	public readonly selectList: SelectList;
	private _items: SelectItem[];

	constructor(
		items: SelectItem[],
		options?: WidgetOptions & {
			maxVisible?: number;
			theme?: SelectListTheme;
			layout?: SelectListLayoutOptions;
		},
	) {
		super(options);
		this.canFocus = true;
		this._items = [...items];
		this.selectList = new SelectList(
			this._items,
			options?.maxVisible ?? 8,
			options?.theme ?? DEFAULT_SELECT_THEME,
			options?.layout,
		);
		this.selectList.onSelect = (item) => {
			const idx = this._items.indexOf(item);
			this.postMessage(new OptionSelected(item.value, item.label || item.value, idx, this));
		};
	}

	setItems(items: SelectItem[]): void {
		this._items = [...items];
		(this.selectList as unknown as { items: SelectItem[]; filteredItems: SelectItem[] }).items = this._items;
		this.selectList.setFilter("");
		this.refresh({ layout: true, repaint: true });
	}

	setFilter(filter: string): void {
		this.selectList.setFilter(filter);
		this.refresh({ layout: true, repaint: true });
	}

	getSelectedItem(): SelectItem | null {
		return this.selectList.getSelectedItem();
	}

	override handleInput(data: string): void {
		super.handleInput(data);
		this.selectList.handleInput(data);
		this.refresh({ layout: false, repaint: true });
	}

	protected override renderContent(contentWidth: number): string[] {
		return this.selectList.render(contentWidth);
	}
}

/**
 * Single-line text input widget wrapping `Input` and emitting `InputChanged` and `InputSubmitted` messages.
 */
export class TextualInput extends Widget {
	public readonly innerInput: Input;
	public placeholder: string;

	constructor(options?: WidgetOptions & InputOptions & { value?: string; placeholder?: string }) {
		super(options);
		this.canFocus = true;
		this.placeholder = options?.placeholder ?? "";
		this.innerInput = new Input({ masked: options?.masked });
		if (options?.value) {
			this.innerInput.setValue(options.value);
		}
		this.innerInput.onSubmit = (val) => {
			this.postMessage(new InputSubmitted(val, this));
		};
	}

	get value(): string {
		return this.innerInput.getValue();
	}

	set value(val: string) {
		const prev = this.innerInput.getValue();
		this.innerInput.setValue(val);
		if (prev !== val) {
			this.postMessage(new InputChanged(val, this));
			this.refresh({ layout: false, repaint: true });
		}
	}

	override handleInput(data: string): void {
		super.handleInput(data);
		const before = this.innerInput.getValue();
		this.innerInput.focused = this.focused;
		this.innerInput.handleInput(data);
		const after = this.innerInput.getValue();
		if (before !== after) {
			this.postMessage(new InputChanged(after, this));
		}
		this.refresh({ layout: false, repaint: true });
	}

	protected override renderContent(contentWidth: number): string[] {
		this.innerInput.focused = this.focused;
		if (!this.focused && this.innerInput.getValue().length === 0 && this.placeholder) {
			return [truncateToWidth(`\x1b[2m> ${this.placeholder}\x1b[0m`, contentWidth, "…", true)];
		}
		return this.innerInput.render(contentWidth);
	}
}

const DEFAULT_EDITOR_THEME: EditorTheme = {
	borderColor: (s) => s,
	selectList: DEFAULT_SELECT_THEME,
};

/**
 * Multi-line `TextArea` widget wrapping `Editor` and emitting `InputChanged` and `InputSubmitted`.
 */
export class TextArea extends Widget {
	private _editor: Editor | null = null;
	private _initialText: string;
	private _editorTheme: EditorTheme;
	private _editorOptions: EditorOptions;

	constructor(
		text = "",
		options?: WidgetOptions & {
			theme?: EditorTheme;
			editorOptions?: EditorOptions;
		},
	) {
		super(options);
		this.canFocus = true;
		this._initialText = text;
		this._editorTheme = options?.theme ?? DEFAULT_EDITOR_THEME;
		this._editorOptions = options?.editorOptions ?? {};
	}

	private ensureEditor(): Editor | null {
		if (this._editor) return this._editor;
		if (!this.app) return null;
		this._editor = new Editor(this.app.tui, this._editorTheme, this._editorOptions);
		if (this._initialText) {
			this._editor.setText(this._initialText);
		}
		this._editor.onChange = (val) => {
			this.postMessage(new InputChanged(val, this));
		};
		this._editor.onSubmit = (val) => {
			this.postMessage(new InputSubmitted(val, this));
		};
		return this._editor;
	}

	get text(): string {
		return this._editor ? this._editor.getText() : this._initialText;
	}

	set text(val: string) {
		this._initialText = val;
		if (this._editor) {
			this._editor.setText(val);
		}
		this.refresh({ layout: true, repaint: true });
	}

	override handleInput(data: string): void {
		super.handleInput(data);
		const editor = this.ensureEditor();
		if (editor) {
			editor.focused = this.focused;
			editor.handleInput(data);
			this.refresh({ layout: true, repaint: true });
		}
	}

	protected override renderContent(contentWidth: number): string[] {
		const editor = this.ensureEditor();
		if (!editor) {
			return wrapTextWithAnsi(this._initialText, contentWidth);
		}
		editor.focused = this.focused;
		return editor.render(contentWidth);
	}
}

const DEFAULT_MARKDOWN_THEME: MarkdownTheme = {
	heading: (t) => `\x1b[1;36m${t}\x1b[0m`,
	link: (t) => `\x1b[4;34m${t}\x1b[0m`,
	linkUrl: (t) => `\x1b[2m${t}\x1b[0m`,
	code: (t) => `\x1b[33m${t}\x1b[0m`,
	codeBlock: (t) => t,
	codeBlockBorder: (t) => `\x1b[2m${t}\x1b[0m`,
	quote: (t) => `\x1b[3m${t}\x1b[0m`,
	quoteBorder: (t) => `\x1b[2m${t}\x1b[0m`,
	hr: (t) => `\x1b[2m${t}\x1b[0m`,
	listBullet: (t) => `\x1b[36m${t}\x1b[0m`,
	bold: (t) => `\x1b[1m${t}\x1b[0m`,
	italic: (t) => `\x1b[3m${t}\x1b[0m`,
	strikethrough: (t) => `\x1b[9m${t}\x1b[0m`,
	underline: (t) => `\x1b[4m${t}\x1b[0m`,
};

/**
 * Markdown rendering widget wrapping `Markdown`.
 */
export class TextualMarkdown extends Widget {
	public readonly innerMarkdown: Markdown;

	constructor(
		markdown = "",
		options?: WidgetOptions & {
			theme?: MarkdownTheme;
			markdownOptions?: MarkdownOptions;
		},
	) {
		super(options);
		this.innerMarkdown = new Markdown(
			markdown,
			0,
			0,
			options?.theme ?? DEFAULT_MARKDOWN_THEME,
			undefined,
			options?.markdownOptions,
		);
	}

	update(markdown: string): this {
		this.innerMarkdown.setText(markdown);
		this.refresh({ layout: true, repaint: true });
		return this;
	}

	override invalidate(): void {
		super.invalidate();
		this.innerMarkdown.invalidate();
	}

	protected override renderContent(contentWidth: number): string[] {
		const lines = this.innerMarkdown.render(contentWidth);
		this.selectionRegions = [...this.innerMarkdown.getSelectionRegions()];
		return lines;
	}
}

/**
 * Animated loading spinner widget wrapping `Loader`.
 */
export class LoadingIndicator extends Widget {
	private _loader: Loader | null = null;
	private _message: string;
	private _indicatorOptions?: LoaderIndicatorOptions;

	constructor(message = "Loading...", options?: WidgetOptions & { indicator?: LoaderIndicatorOptions }) {
		super(options);
		this._message = message;
		this._indicatorOptions = options?.indicator;
	}

	setMessage(message: string): void {
		this._message = message;
		this._loader?.setMessage(message);
		this.refresh({ layout: false, repaint: true });
	}

	protected override onUnmount(): void {
		this._loader?.stop();
		this._loader = null;
	}

	protected override renderContent(contentWidth: number): string[] {
		if (!this._loader && this.app) {
			this._loader = new Loader(
				this.app.tui,
				(s) => `\x1b[36m${s}\x1b[0m`,
				(s) => s,
				this._message,
				this._indicatorOptions,
			);
		}
		if (this._loader) {
			return this._loader.render(contentWidth);
		}
		return [truncateToWidth(`⠋ ${this._message}`, contentWidth, "…")];
	}
}
