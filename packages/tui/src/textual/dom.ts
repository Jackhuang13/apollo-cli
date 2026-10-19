import type { App } from "./app.js";
import { matchesSelector, parseDeclarations, parseSelector, type SelectableDOMNode } from "./css/parser.js";
import { type StyleProperties, Styles } from "./css/styles.js";
import { MessagePump } from "./messages.js";
import type { Screen } from "./screen.js";
import type { Widget } from "./widget.js";

export interface DOMNodeOptions {
	id?: string;
	classes?: string | string[];
	disabled?: boolean;
}

/**
 * Result wrapper for DOM queries (`node.query(selector)`), providing chainable
 * operations and iteration matching Textual's `DOMQuery`.
 */
export class DOMQuery<T extends Widget = Widget> implements Iterable<T> {
	private readonly items: T[];

	constructor(items: T[]) {
		this.items = [...items];
	}

	get length(): number {
		return this.items.length;
	}

	[Symbol.iterator](): Iterator<T> {
		return this.items[Symbol.iterator]();
	}

	results(): T[] {
		return [...this.items];
	}

	first(): T {
		if (this.items.length === 0) {
			throw new Error("DOMQuery matched no widgets (.first() called on empty query)");
		}
		return this.items[0]!;
	}

	last(): T {
		if (this.items.length === 0) {
			throw new Error("DOMQuery matched no widgets (.last() called on empty query)");
		}
		return this.items[this.items.length - 1]!;
	}

	filter(selectorOrPredicate: string | ((widget: T) => boolean)): DOMQuery<T> {
		if (typeof selectorOrPredicate === "function") {
			return new DOMQuery(this.items.filter(selectorOrPredicate));
		}
		const selectors = selectorOrPredicate
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean)
			.map((s) => parseSelector(s));
		return new DOMQuery(this.items.filter((w) => selectors.some((sel) => matchesSelector(w, sel))));
	}

	addClass(...names: string[]): this {
		for (const item of this.items) {
			item.addClass(...names);
		}
		return this;
	}

	removeClass(...names: string[]): this {
		for (const item of this.items) {
			item.removeClass(...names);
		}
		return this;
	}

	setStyles(cssOrProps: string | StyleProperties): this {
		for (const item of this.items) {
			if (typeof cssOrProps === "string") {
				item.setStyles(cssOrProps);
			} else {
				item.styles.mergeInline(cssOrProps);
			}
		}
		return this;
	}

	remove(): this {
		for (const item of this.items) {
			item.remove();
		}
		return this;
	}
}

/**
 * Base DOM node in the Textual widget hierarchy.
 */
export class DOMNode extends MessagePump implements SelectableDOMNode {
	public id: string | undefined;
	public readonly classes = new Set<string>();
	public readonly styles: Styles;
	public parent: DOMNode | null = null;
	public readonly children: Widget[] = [];
	public disabled = false;
	public hovered = false;

	constructor(options?: DOMNodeOptions) {
		super();
		this.id = options?.id;
		if (options?.disabled !== undefined) {
			this.disabled = options.disabled;
		}
		if (options?.classes) {
			const list = Array.isArray(options.classes) ? options.classes : options.classes.split(/\s+/);
			for (const c of list) {
				const trimmed = c.trim();
				if (trimmed) this.classes.add(trimmed);
			}
		}
		this.styles = new Styles((layoutChanged) => {
			this.refresh({ layout: layoutChanged, repaint: true });
		});
	}

	get cssName(): string {
		return this.constructor.name;
	}

	get cssTypeNames(): readonly string[] {
		const names: string[] = [];
		let proto = Object.getPrototypeOf(this);
		while (proto && proto !== Object.prototype) {
			const name = proto.constructor?.name;
			if (name && !names.includes(name)) {
				names.push(name);
			}
			if (name === "DOMNode") break;
			proto = Object.getPrototypeOf(proto);
		}
		return names;
	}

	override getBubbleParent(): MessagePump | null {
		return this.parent;
	}

	get app(): App | null {
		let curr: DOMNode | null = this;
		while (curr) {
			if ("screenStack" in curr && "tui" in curr) {
				return curr as unknown as App;
			}
			curr = curr.parent;
		}
		return null;
	}

	get screen(): Screen | null {
		let curr: DOMNode | null = this;
		while (curr) {
			if ("focusNext" in curr && "focusPrevious" in curr && "setFocus" in curr) {
				return curr as unknown as Screen;
			}
			curr = curr.parent;
		}
		return null;
	}

	hasPseudoClass(pseudo: string): boolean {
		switch (pseudo) {
			case "focus":
				return "focused" in this && (this as unknown as { focused: boolean }).focused === true;
			case "focus-within":
				return this.hasFocusWithin();
			case "hover":
				return this.hovered;
			case "disabled":
				return this.disabled;
			case "enabled":
				return !this.disabled;
			default:
				return false;
		}
	}

	private hasFocusWithin(): boolean {
		if ("focused" in this && (this as unknown as { focused: boolean }).focused === true) {
			return true;
		}
		for (const child of this.children) {
			if (child.hasPseudoClass("focus-within")) {
				return true;
			}
		}
		return false;
	}

	addClass(...names: string[]): this {
		let changed = false;
		for (const raw of names) {
			for (const name of raw.split(/\s+/)) {
				const trimmed = name.trim();
				if (trimmed && !this.classes.has(trimmed)) {
					this.classes.add(trimmed);
					changed = true;
				}
			}
		}
		if (changed) {
			this.refreshStyles();
			this.refresh({ layout: true, repaint: true });
		}
		return this;
	}

	removeClass(...names: string[]): this {
		let changed = false;
		for (const raw of names) {
			for (const name of raw.split(/\s+/)) {
				const trimmed = name.trim();
				if (trimmed && this.classes.has(trimmed)) {
					this.classes.delete(trimmed);
					changed = true;
				}
			}
		}
		if (changed) {
			this.refreshStyles();
			this.refresh({ layout: true, repaint: true });
		}
		return this;
	}

	toggleClass(name: string, force?: boolean): this {
		const shouldHave = force !== undefined ? force : !this.classes.has(name);
		if (shouldHave) {
			this.addClass(name);
		} else {
			this.removeClass(name);
		}
		return this;
	}

	hasClass(name: string): boolean {
		return this.classes.has(name);
	}

	setClass(enabled: boolean, ...names: string[]): this {
		if (enabled) {
			return this.addClass(...names);
		}
		return this.removeClass(...names);
	}

	setStyles(css: string): this {
		const vars = this.app?.stylesheet.getVariables() ?? {};
		const parsed = parseDeclarations(css, vars);
		this.styles.mergeInline(parsed);
		return this;
	}

	refreshStyles(): void {
		const app = this.app;
		if (app) {
			this.styles.setCascaded(app.stylesheet.computeStyles(this));
		}
		for (const child of this.children) {
			child.refreshStyles();
		}
	}

	refresh(_options?: { layout?: boolean; repaint?: boolean }): void {
		this.app?.requestRender();
	}

	/**
	 * Walk all descendant widgets in depth-first pre-order.
	 */
	walkChildren(): Widget[] {
		const result: Widget[] = [];
		const visit = (node: DOMNode): void => {
			for (const child of node.children) {
				result.push(child);
				visit(child);
			}
		};
		visit(this);
		return result;
	}

	/**
	 * Query descendant widgets matching a TCSS selector string.
	 */
	query<T extends Widget = Widget>(selector: string): DOMQuery<T> {
		const selectors = selector
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean)
			.map((s) => parseSelector(s));

		if (selectors.length === 0) {
			return new DOMQuery<T>([]);
		}

		const matches: T[] = [];
		for (const descendant of this.walkChildren()) {
			if (selectors.some((sel) => matchesSelector(descendant, sel))) {
				matches.push(descendant as T);
			}
		}
		return new DOMQuery<T>(matches);
	}

	/**
	 * Return the first descendant widget matching `selector`, or throw if none match.
	 */
	queryOne<T extends Widget = Widget>(selector: string): T {
		const q = this.query<T>(selector);
		return q.first();
	}
}
