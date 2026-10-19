import { ProcessTerminal, type Terminal } from "../terminal.js";
import { type OverlayHandle, TUI, type TuiStopOptions } from "../tui.js";
import type { Binding } from "./binding.js";
import { Stylesheet } from "./css/parser.js";
import { DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME, type ThemeVariables } from "./css/styles.js";
import { DOMNode, type DOMNodeOptions, type DOMQuery } from "./dom.js";
import { ResizeEvent } from "./messages.js";
import { createPilot, type Pilot, VirtualTerminal } from "./pilot.js";
import { initializeReactives } from "./reactive.js";
import { ModalScreen, Screen } from "./screen.js";
import type { Widget } from "./widget.js";

export interface NotifyOptions {
	title?: string;
	severity?: "information" | "warning" | "error";
	timeout?: number;
}

export interface AppOptions extends DOMNodeOptions {
	terminal?: Terminal;
	css?: string;
	theme?: string;
	inline?: boolean;
}

/**
 * Root Textual Application class.
 * Manages `TUI`, `Terminal`, `Stylesheet`, themes, `screenStack`, actions, and headless `runTest()`.
 */
export class App<TReturn = void> extends DOMNode {
	public static CSS = "";
	public static BINDINGS: Binding[] = [];
	public static TITLE = "";
	public static SUB_TITLE = "";

	public terminal: Terminal;
	public readonly tui: TUI;
	public readonly stylesheet: Stylesheet;
	public readonly screenStack: Screen<unknown>[] = [];
	public title: string;
	public subTitle: string;
	public inlineMode: boolean;

	private _themes = new Map<string, ThemeVariables>([
		["textual-dark", DEFAULT_DARK_THEME],
		["dark", DEFAULT_DARK_THEME],
		["textual-light", DEFAULT_LIGHT_THEME],
		["light", DEFAULT_LIGHT_THEME],
	]);
	private _themeName = "textual-dark";
	private _registeredWidgetCss = new Map<string, string>();
	private _extraCss: string;
	private _running = false;
	private _usesDefaultProcessTerminal: boolean;
	private _exitResolvers: Array<(val: TReturn) => void> = [];
	private _returnValue: TReturn | undefined;
	private _notificationHandle: OverlayHandle | null = null;
	private _notificationTimer: ReturnType<typeof setTimeout> | null = null;
	private _lastNotification: { message: string; options?: NotifyOptions } | null = null;
	private _clipboardText = "";

	constructor(options?: AppOptions) {
		super(options);
		this.terminal = options?.terminal ?? new VirtualTerminal(80, 24);
		this._usesDefaultProcessTerminal = !options?.terminal;
		this.tui = new TUI(this.terminal);
		this._extraCss = options?.css ?? "";
		this.inlineMode = options?.inline ?? false;
		if (options?.theme && this._themes.has(options.theme)) {
			this._themeName = options.theme;
		}

		const ctor = this.constructor as typeof App;
		this.title = ctor.TITLE || ctor.name;
		this.subTitle = ctor.SUB_TITLE || "";

		this.stylesheet = new Stylesheet(this._themes.get(this._themeName) ?? DEFAULT_DARK_THEME);
		this.rebuildStylesheet();

		// Install default base screen
		const defaultScreen = new Screen({ id: "_default" });
		defaultScreen.parent = this;
		this.screenStack.push(defaultScreen);

		// Intercept global input on TUI so App/Screen bindings and focused widgets work seamlessly
		this.tui.addInputListener((data) => {
			if (this.handleGlobalInput(data)) {
				return { consume: true };
			}
			return undefined;
		});
	}

	/**
	 * Active screen at the top of the screen stack.
	 */
	get screen(): Screen<unknown> {
		return this.screenStack[this.screenStack.length - 1]!;
	}

	get returnValue(): TReturn | undefined {
		return this._returnValue;
	}

	get clipboard(): string {
		return this._clipboardText;
	}

	get lastNotification(): { message: string; options?: NotifyOptions } | null {
		return this._lastNotification;
	}

	/**
	 * Register a custom theme dictionary of `$variable: value` pairs.
	 */
	registerTheme(name: string, variables: ThemeVariables): void {
		this._themes.set(name, { ...DEFAULT_DARK_THEME, ...variables });
		if (this._themeName === name) {
			this.rebuildStylesheet();
			this.refreshStyles();
			this.requestRender();
		}
	}

	get theme(): string {
		return this._themeName;
	}

	set theme(name: string) {
		const themeVars = this._themes.get(name);
		if (!themeVars) return;
		this._themeName = name;
		this.rebuildStylesheet();
		this.refreshStyles();
		this.requestRender();
	}

	/**
	 * Internal helper to register a widget class's `DEFAULT_CSS` and rebuild the cascade.
	 */
	public registerWidgetCss(widgetName: string, css: string): void {
		if (!css || this._registeredWidgetCss.get(widgetName) === css) return;
		this._registeredWidgetCss.set(widgetName, css);
		this.rebuildStylesheet();
	}

	private rebuildStylesheet(): void {
		const themeVars = this._themes.get(this._themeName) ?? DEFAULT_DARK_THEME;
		this.stylesheet.clear();
		this.stylesheet.setThemeVariables(themeVars);

		for (const css of this._registeredWidgetCss.values()) {
			this.stylesheet.parse(css);
		}
		for (const scr of this.screenStack) {
			const scrCtor = scr.constructor as typeof Screen;
			if (scrCtor.CSS) {
				this.stylesheet.parse(scrCtor.CSS);
			}
		}
		const appCtor = this.constructor as typeof App;
		if (appCtor.CSS) {
			this.stylesheet.parse(appCtor.CSS);
		}
		if (this._extraCss) {
			this.stylesheet.parse(this._extraCss);
		}
	}

	/**
	 * Override in `App` subclasses to yield widgets into the default screen.
	 */
	compose(): Iterable<Widget> {
		return [];
	}

	protected onMount(): void {}

	/**
	 * Query widgets on the active screen.
	 */
	override query<T extends Widget = Widget>(selector: string): DOMQuery<T> {
		return this.screen.query<T>(selector);
	}

	/**
	 * Query a single widget on the active screen.
	 */
	override queryOne<T extends Widget = Widget>(selector: string): T {
		return this.screen.queryOne<T>(selector);
	}

	/**
	 * Mount widgets onto the active screen.
	 */
	mount(...widgets: Widget[]): this {
		this.screen.mount(...widgets);
		this.syncScreenToTui();
		return this;
	}

	/**
	 * Push a new `Screen` (or `ModalScreen`) onto the screen stack and return a Promise
	 * that resolves when `screen.dismiss(result)` is called.
	 */
	pushScreen<T = unknown>(screen: Screen<T>): Promise<T> {
		screen.parent = this;
		this.screenStack.push(screen as Screen<unknown>);
		this.rebuildStylesheet();
		screen.triggerMount();

		if (screen instanceof ModalScreen) {
			screen.overlayHandle = this.tui.showOverlay(screen, screen.overlayOptions);
			const chain = screen.getFocusChain();
			if (chain.length > 0) {
				screen.setFocus(chain[0]!);
			} else {
				this.tui.setFocus(screen);
			}
		} else {
			this.syncScreenToTui();
		}

		this.requestRender();
		return screen.waitForDismiss();
	}

	/**
	 * Pop the top screen from the screen stack (unless it is the last screen).
	 */
	popScreen(): Screen<unknown> | undefined {
		if (this.screenStack.length <= 1) return undefined;
		const popped = this.screenStack.pop()!;
		if (popped instanceof ModalScreen && popped.overlayHandle) {
			popped.overlayHandle.hide();
			popped.overlayHandle = null;
		}
		popped.triggerUnmount();
		popped.parent = null;
		this.rebuildStylesheet();
		this.syncScreenToTui();
		this.requestRender();
		return popped;
	}

	/**
	 * Replace the current top screen with `screen`.
	 */
	switchScreen<T = unknown>(screen: Screen<T>): void {
		if (this.screenStack.length > 0) {
			const top = this.screenStack.pop()!;
			if (top instanceof ModalScreen && top.overlayHandle) {
				top.overlayHandle.hide();
				top.overlayHandle = null;
			}
			top.triggerUnmount();
			top.parent = null;
		}
		screen.parent = this;
		this.screenStack.push(screen as Screen<unknown>);
		this.rebuildStylesheet();
		screen.triggerMount();
		this.syncScreenToTui();
		this.requestRender();
	}

	/**
	 * Internal helper called by `Screen.dismiss()`.
	 */
	public dismissScreen(target: Screen<any>): void {
		const idx = this.screenStack.indexOf(target);
		if (idx === -1) return;
		this.screenStack.splice(idx, 1);
		if (target instanceof ModalScreen && target.overlayHandle) {
			target.overlayHandle.hide();
			target.overlayHandle = null;
		}
		target.triggerUnmount();
		target.parent = null;
		if (this.screenStack.length === 0) {
			const fallback = new Screen({ id: "_default" });
			fallback.parent = this;
			this.screenStack.push(fallback);
			fallback.triggerMount();
		}
		this.rebuildStylesheet();
		this.syncScreenToTui();
		this.requestRender();
	}

	/**
	 * Run an action by name (e.g. `"quit"` -> `action_quit()`).
	 */
	async runAction(actionSpec: string): Promise<boolean> {
		const activeTarget = this.screen.focusedWidget ?? this.screen;
		const handled = activeTarget.checkAndRunBindings(actionSpec);
		if (handled) return true;

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

		for (const node of [this.screen.focusedWidget, this.screen, this]) {
			if (!node) continue;
			const rec = node as unknown as Record<string, unknown>;
			for (const methodName of methodCandidates) {
				const fn = rec[methodName];
				if (typeof fn === "function") {
					await (fn as (...a: string[]) => unknown).apply(node, args);
					this.requestRender();
					return true;
				}
			}
		}
		return false;
	}

	public action_quit(): void {
		this.exit();
	}

	/**
	 * Display a toast notification overlay in the bottom-right corner.
	 */
	notify(message: string, options?: NotifyOptions): void {
		this._lastNotification = { message, options };
		if (this._notificationHandle) {
			this._notificationHandle.hide();
			this._notificationHandle = null;
		}
		if (this._notificationTimer) {
			clearTimeout(this._notificationTimer);
			this._notificationTimer = null;
		}

		const titlePrefix = options?.title ? `${options.title}: ` : "";
		const text = ` ${titlePrefix}${message} `;
		const toastComponent = {
			render: (width: number) => {
				const bar = "─".repeat(Math.max(0, width - 2));
				const content = text.slice(0, Math.max(1, width - 2)).padEnd(Math.max(1, width - 2), " ");
				return [`╭${bar}╮`, `│${content}│`, `╰${bar}╯`];
			},
			invalidate: () => {},
		};

		this._notificationHandle = this.tui.showOverlay(toastComponent, {
			anchor: "bottom-right",
			width: Math.min(50, Math.max(16, text.length + 2)),
			margin: 1,
			nonCapturing: true,
		});

		const timeoutMs = options?.timeout ?? 3000;
		if (timeoutMs > 0) {
			this._notificationTimer = setTimeout(() => {
				this._notificationHandle?.hide();
				this._notificationHandle = null;
				this._notificationTimer = null;
			}, timeoutMs);
			this._notificationTimer.unref?.();
		}
	}

	/**
	 * Copy text to the system clipboard via OSC 52.
	 */
	copyToClipboard(text: string): void {
		this._clipboardText = text;
		const base64 = Buffer.from(text, "utf8").toString("base64");
		this.terminal.write(`\x1b]52;c;${base64}\x07`);
	}

	public requestRender(): void {
		if (!this._running) return;
		this.tui.requestRender();
	}

	private handleGlobalInput(data: string): boolean {
		const activeScreen = this.screen;
		const target = activeScreen.focusedWidget ?? activeScreen;

		// Check priority bindings first
		if (target.checkAndRunBindings(data, true) || this.checkAppBindings(data, true)) {
			this.requestRender();
			return true;
		}

		// Delegate to active screen (which dispatches to focusedWidget or itself)
		activeScreen.handleInput(data);

		// Check non-priority App bindings
		this.checkAppBindings(data, false);
		this.requestRender();
		return true;
	}

	private checkAppBindings(rawData: string, priorityOnly: boolean): boolean {
		const ctor = this.constructor as typeof App;
		const bindings = ctor.BINDINGS ?? [];
		for (const b of bindings) {
			if (priorityOnly && !b.priority) continue;
			if (b.matches(rawData)) {
				void this.runAction(b.action);
				return true;
			}
		}
		return false;
	}

	private syncScreenToTui(): void {
		const baseScreen = this.getActiveNonModalScreen();
		baseScreen.refreshStyles();

		this.tui.clear();
		this.tui.addChild(baseScreen);

		if (this._running && !this.inlineMode) {
			if (this.tui.isFullscreen()) {
				this.tui.exitFullscreen({ flush: false, leaveAltScreen: false });
			}
			this.tui.enterFullscreen(baseScreen.toFullscreenOptions());
		}

		const focusTarget = this.screen.focusedWidget ?? baseScreen.getFocusChain()[0] ?? this.screen;
		if (focusTarget !== this.screen) {
			this.screen.setFocus(focusTarget as Widget);
		} else {
			this.tui.setFocus(this.screen);
		}
	}

	private getActiveNonModalScreen(): Screen<unknown> {
		for (let i = this.screenStack.length - 1; i >= 0; i--) {
			const s = this.screenStack[i]!;
			if (!(s instanceof ModalScreen)) {
				return s;
			}
		}
		return this.screenStack[0]!;
	}

	/**
	 * Initialize composition, mount the default screen, and start the TUI.
	 */
	start(): void {
		if (this._running) return;
		if (this._usesDefaultProcessTerminal) {
			const procTerm = new ProcessTerminal();
			this.terminal = procTerm;
			(this.tui as unknown as { terminal: Terminal }).terminal = procTerm;
		}
		this._running = true;
		initializeReactives(this);

		const defaultScreen = this.screenStack[0]!;
		if (defaultScreen.children.length === 0) {
			for (const w of this.compose()) {
				defaultScreen.mount(w);
			}
		}
		this.rebuildStylesheet();
		defaultScreen.triggerMount();
		this.onMount();

		this.tui.start();
		this.syncScreenToTui();
	}

	/**
	 * Stop the TUI and clean up timers.
	 */
	stop(options?: TuiStopOptions): void {
		if (!this._running) return;
		this._running = false;
		if (this._notificationTimer) {
			clearTimeout(this._notificationTimer);
			this._notificationTimer = null;
		}
		for (const scr of this.screenStack) {
			scr.triggerUnmount();
		}
		this.tui.stop(options);
	}

	/**
	 * Exit the application with an optional return value, resolving `run()`.
	 */
	exit(result?: TReturn): void {
		this._returnValue = result;
		this.stop();
		const resolvers = [...this._exitResolvers];
		this._exitResolvers = [];
		for (const r of resolvers) {
			r(result as TReturn);
		}
	}

	/**
	 * Start the app and wait until `exit(result)` is called.
	 */
	run(): Promise<TReturn> {
		this.start();
		return new Promise<TReturn>((resolve) => {
			if (!this._running) {
				resolve(this._returnValue as TReturn);
				return;
			}
			this._exitResolvers.push(resolve);
		});
	}

	/**
	 * Dispatch a `ResizeEvent` to the active screen and re-render.
	 */
	public handleResize(width: number, height: number): void {
		this.screen.dispatchMessageSync(new ResizeEvent(width, height, this.screen));
		this.requestRender();
	}

	/**
	 * Launch this `App` inside a headless `VirtualTerminal` and return a `Pilot<this>`
	 * for deterministic automated testing.
	 */
	async runTest(options?: { columns?: number; rows?: number }): Promise<Pilot<this>> {
		return createPilot(this as unknown as App<any>, options) as unknown as Promise<Pilot<this>>;
	}
}
