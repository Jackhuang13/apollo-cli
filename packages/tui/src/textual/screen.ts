import { type Component, Container, type FullscreenOptions, type OverlayHandle, type OverlayOptions } from "../tui.js";
import { Binding } from "./binding.js";
import { partitionDockedChildren } from "./layout.js";
import { Widget, type WidgetOptions } from "./widget.js";

/**
 * Screen represents a top-level view in a Textual `App`.
 * Manages the focus ring (`focused`, `setFocus`, `focusNext`, `focusPrevious`),
 * screen-scoped `CSS` and `BINDINGS`, overlays, and maps docked widgets onto `TUI`'s
 * `FullscreenOptions` (`pin`, `scroll`, `dock`).
 */
export class Screen<TResult = unknown> extends Widget {
	public static CSS = "";
	public static override BINDINGS: Binding[] = [
		new Binding("tab", "focus_next", "Focus next", { show: false }),
		new Binding("shift+tab", "focus_previous", "Focus previous", { show: false }),
	];

	private _focusedWidget: Widget | null = null;
	private _resultResolvers: Array<(result: TResult) => void> = [];
	private _localOverlays: Array<{ widget: Widget; options?: OverlayOptions; handle?: OverlayHandle }> = [];

	/**
	 * Return the currently focused widget on this screen.
	 */
	get focusedWidget(): Widget | null {
		return this._focusedWidget;
	}

	/**
	 * Return all focusable, visible, enabled widgets in tab order.
	 */
	getFocusChain(): Widget[] {
		this.ensureComposed();
		const chain: Widget[] = [];
		const visit = (node: Widget): void => {
			if (node.styles.display === "none" || node.styles.visibility === "hidden" || node.disabled) {
				return;
			}
			if (node !== this && node.canFocus) {
				chain.push(node);
			}
			for (const child of node.children) {
				visit(child);
			}
		};
		visit(this);
		return chain;
	}

	/**
	 * Set keyboard focus to `widget` (or clear focus if `null`).
	 */
	setFocus(widget: Widget | null): void {
		if (this._focusedWidget === widget) return;
		if (this._focusedWidget) {
			const prev = this._focusedWidget;
			this._focusedWidget = null;
			prev.focused = false;
		}
		this._focusedWidget = widget;
		if (widget) {
			widget.focused = true;
		}
		if (this.app && this.app.screen === this) {
			this.app.tui.setFocus(widget ?? this);
		}
		this.refresh({ layout: false, repaint: true });
	}

	/**
	 * Move focus to the next focusable widget in the focus ring.
	 */
	focusNext(): Widget | null {
		const chain = this.getFocusChain();
		if (chain.length === 0) {
			this.setFocus(null);
			return null;
		}
		const currentIdx = this._focusedWidget ? chain.indexOf(this._focusedWidget) : -1;
		const nextIdx = (currentIdx + 1) % chain.length;
		const next = chain[nextIdx]!;
		this.setFocus(next);
		return next;
	}

	/**
	 * Move focus to the previous focusable widget in the focus ring.
	 */
	focusPrevious(): Widget | null {
		const chain = this.getFocusChain();
		if (chain.length === 0) {
			this.setFocus(null);
			return null;
		}
		const currentIdx = this._focusedWidget ? chain.indexOf(this._focusedWidget) : 0;
		const prevIdx = (currentIdx - 1 + chain.length) % chain.length;
		const prev = chain[prevIdx]!;
		this.setFocus(prev);
		return prev;
	}

	public action_focus_next(): void {
		this.focusNext();
	}

	public action_focus_previous(): void {
		this.focusPrevious();
	}

	/**
	 * Show an overlay widget on top of this screen.
	 */
	showOverlay(widget: Widget, options?: OverlayOptions): OverlayHandle {
		widget.parent = this;
		widget.triggerMount();
		if (this.app) {
			const handle = this.app.tui.showOverlay(widget, options);
			this._localOverlays.push({ widget, options, handle });
			return handle;
		}
		const entry: { widget: Widget; options?: OverlayOptions; handle?: OverlayHandle } = { widget, options };
		this._localOverlays.push(entry);
		let hidden = false;
		return {
			hide: () => {
				entry.handle?.hide();
				const idx = this._localOverlays.indexOf(entry);
				if (idx !== -1) this._localOverlays.splice(idx, 1);
			},
			setHidden: (h: boolean) => {
				hidden = h;
				entry.handle?.setHidden(h);
			},
			isHidden: () => entry.handle?.isHidden() ?? hidden,
			focus: () => entry.handle?.focus(),
			unfocus: () => entry.handle?.unfocus(),
			isFocused: () => entry.handle?.isFocused() ?? false,
		};
	}

	/**
	 * Dismiss this screen and resolve any awaiting `pushScreen` promise with `result`.
	 */
	dismiss(result?: TResult): void {
		const resolvers = [...this._resultResolvers];
		this._resultResolvers = [];
		if (this.app) {
			this.app.dismissScreen(this);
		}
		for (const resolve of resolvers) {
			resolve(result as TResult);
		}
	}

	/**
	 * Internal helper used by `App.pushScreen` to await `dismiss(result)`.
	 */
	public waitForDismiss(): Promise<TResult> {
		return new Promise<TResult>((resolve) => {
			this._resultResolvers.push(resolve);
		});
	}

	/**
	 * Build `FullscreenOptions` (`pin` for `dock: top`, `dock` for `dock: bottom`, `scroll` for body)
	 * so this `Screen` can drive `TUI.enterFullscreen`.
	 */
	toFullscreenOptions(): FullscreenOptions {
		this.ensureComposed();
		const groups = partitionDockedChildren(this.children);

		const pinContainer = new Container();
		for (const w of groups.top) {
			pinContainer.addChild(w);
		}

		const dockContainer = new Container();
		for (const w of groups.bottom) {
			dockContainer.addChild(w);
		}

		const scrollComponents: Component[] =
			groups.left.length > 0 || groups.right.length > 0 ? [this] : [...groups.flow];

		return {
			pin: groups.top.length > 0 ? pinContainer : undefined,
			scroll: scrollComponents,
			dock: dockContainer,
			mouse: true,
			viewportControls: true,
		};
	}

	override handleInput(data: string): void {
		// Priority bindings on screen/app run before focused widget
		const target = this._focusedWidget ?? this;
		if (target.checkAndRunBindings(data, true)) {
			return;
		}
		if (this._focusedWidget && this._focusedWidget !== this) {
			this._focusedWidget.handleInput(data);
			return;
		}
		super.handleInput(data);
	}
}

/**
 * ModalScreen renders as a centered modal overlay over the active screen and
 * resolves the `pushScreen` promise when `dismiss(result)` is called.
 */
export class ModalScreen<TResult = unknown> extends Screen<TResult> {
	public static override BINDINGS: Binding[] = [
		...Screen.BINDINGS,
		new Binding("escape", "dismiss_modal", "Dismiss", { show: false }),
	];

	public overlayOptions: OverlayOptions = {
		anchor: "center",
		width: "60%",
		maxHeight: "80%",
	};

	public overlayHandle: OverlayHandle | null = null;

	constructor(options?: WidgetOptions & { overlayOptions?: OverlayOptions }) {
		super(options);
		if (options?.overlayOptions) {
			this.overlayOptions = { ...this.overlayOptions, ...options.overlayOptions };
		}
		if (this.styles.borderStyle === "none") {
			this.styles.borderStyle = "round";
		}
	}

	public action_dismiss_modal(): void {
		this.dismiss();
	}
}
