import type { Terminal, TerminalStopOptions } from "../terminal.js";
import { stripAnsi } from "../utils.js";
import type { App } from "./app.js";
import { ClickEvent } from "./messages.js";

const KEY_NAME_TO_SEQUENCE: Record<string, string> = {
	enter: "\r",
	return: "\r",
	tab: "\t",
	"shift+tab": "\x1b[Z",
	escape: "\x1b",
	esc: "\x1b",
	space: " ",
	backspace: "\x7f",
	delete: "\x1b[3~",
	insert: "\x1b[2~",
	home: "\x1b[H",
	end: "\x1b[F",
	pageup: "\x1b[5~",
	pagedown: "\x1b[6~",
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	f1: "\x1bOP",
	f2: "\x1bOQ",
	f3: "\x1bOR",
	f4: "\x1bOS",
	f5: "\x1b[15~",
	f6: "\x1b[17~",
	f7: "\x1b[18~",
	f8: "\x1b[19~",
	f9: "\x1b[20~",
	f10: "\x1b[21~",
	f11: "\x1b[23~",
	f12: "\x1b[24~",
};

function encodeKeyToTerminalData(key: string): string {
	const lower = key.toLowerCase();
	if (KEY_NAME_TO_SEQUENCE[lower]) {
		return KEY_NAME_TO_SEQUENCE[lower]!;
	}
	const ctrlMatch = lower.match(/^ctrl\+([a-z])$/);
	if (ctrlMatch) {
		const code = ctrlMatch[1]!.charCodeAt(0) - 96;
		return String.fromCharCode(code);
	}
	const altMatch = lower.match(/^alt\+([a-z0-9])$/);
	if (altMatch) {
		return `\x1b${altMatch[1]!}`;
	}
	return key;
}

/**
 * Lightweight in-memory `VirtualTerminal` implementing `Terminal` for `Pilot` testing.
 * Parses ANSI cursor positioning and line writes into a virtual screen buffer without native dependencies.
 */
export class VirtualTerminal implements Terminal {
	private _columns: number;
	private _rows: number;
	private _altScreenActive = false;
	private _mouseTrackingActive = false;
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private screenLines: string[] = [];
	private cursorRow = 0;
	private cursorCol = 0;
	public title = "";

	constructor(columns = 80, rows = 24) {
		this._columns = columns;
		this._rows = rows;
		this.screenLines = new Array<string>(rows).fill("");
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
	}

	async drainInput(): Promise<void> {}

	stop(_options?: TerminalStopOptions): void {
		this.inputHandler = undefined;
		this.resizeHandler = undefined;
	}

	write(data: string): void {
		// Strip synchronized output markers and cursor show/hide
		const cleaned = data
			.replace(/\x1b\[\?2026[hl]/g, "")
			.replace(/\x1b\[\?25[hl]/g, "")
			.replace(/\x1b\[\?1049[hl]/g, "")
			.replace(/\x1b\[\?100[26][hl]/g, "")
			.replace(/\x1b\[\?2004[hl]/g, "");

		// Check if this is a fullscreen absolute-positioned frame (\x1b[row;colH\x1b[2K...)
		const absRegex = /\x1b\[(\d+);1H\x1b\[2K([^\x1b]*(?:\x1b(?!\[\d+;1H\x1b\[2K)[^\x1b]*)*)/g;
		let matchedAbs = false;
		if (cleaned.includes("\x1b[2J\x1b[H")) {
			this.screenLines = new Array<string>(this._rows).fill("");
			this.cursorRow = 0;
			this.cursorCol = 0;
		}
		for (const match of cleaned.matchAll(absRegex)) {
			matchedAbs = true;
			const row = Number.parseInt(match[1]!, 10) - 1;
			let lineContent = match[2] ?? "";
			// Strip trailing cursor move \x1b[r;cH if attached at end of frame
			lineContent = lineContent.replace(/\x1b\[\d+;\d+H$/, "");
			if (row >= 0 && row < this._rows) {
				this.screenLines[row] = lineContent;
			}
		}
		if (matchedAbs) {
			return;
		}

		// Inline mode fallback: split by \r\n
		if (cleaned.includes("\r\n") || cleaned.includes("\x1b[2K")) {
			const parts = cleaned.split(/\r\n/);
			for (let i = 0; i < parts.length; i++) {
				const part = parts[i]!.replace(/\x1b\[2K/g, "").replace(/\r/g, "");
				if (i < this._rows) {
					this.screenLines[i] = part;
				}
			}
		}
	}

	get columns(): number {
		return this._columns;
	}

	get rows(): number {
		return this._rows;
	}

	get cursor(): { row: number; col: number } {
		return { row: this.cursorRow, col: this.cursorCol };
	}

	get kittyProtocolActive(): boolean {
		return true;
	}

	moveBy(lines: number): void {
		this.cursorRow = Math.max(0, this.cursorRow + lines);
	}

	hideCursor(): void {}

	showCursor(): void {}

	clearLine(): void {
		if (this.cursorRow >= 0 && this.cursorRow < this.screenLines.length) {
			this.screenLines[this.cursorRow] = "";
		}
	}

	clearFromCursor(): void {
		for (let r = this.cursorRow; r < this.screenLines.length; r++) {
			this.screenLines[r] = "";
		}
	}

	clearScreen(): void {
		this.screenLines = new Array<string>(this._rows).fill("");
		this.cursorRow = 0;
		this.cursorCol = 0;
	}

	enterAltScreen(): void {
		this._altScreenActive = true;
	}

	leaveAltScreen(): void {
		this._altScreenActive = false;
	}

	get altScreenActive(): boolean {
		return this._altScreenActive;
	}

	setMouseTracking(enabled: boolean): void {
		this._mouseTrackingActive = enabled;
	}

	get mouseTrackingActive(): boolean {
		return this._mouseTrackingActive;
	}

	setTitle(title: string): void {
		this.title = title;
	}

	setProgress(): void {}

	sendInput(data: string): void {
		this.inputHandler?.(data);
	}

	resize(columns: number, rows: number): void {
		this._columns = columns;
		this._rows = rows;
		while (this.screenLines.length < rows) {
			this.screenLines.push("");
		}
		if (this.screenLines.length > rows) {
			this.screenLines = this.screenLines.slice(0, rows);
		}
		this.resizeHandler?.();
	}

	getViewportLines(): string[] {
		return [...this.screenLines];
	}
}

/**
 * Pilot controller for driving a Textual `App` in headless tests.
 */
export class Pilot<TApp extends App<any> = App<any>> {
	public readonly app: TApp;
	public readonly terminal: VirtualTerminal;

	constructor(app: TApp, terminal: VirtualTerminal) {
		this.app = app;
		this.terminal = terminal;
	}

	/**
	 * Simulate pressing one or more keys in sequence and flush pending updates.
	 */
	async press(...keys: string[]): Promise<void> {
		for (const key of keys) {
			const seq = encodeKeyToTerminalData(key);
			this.terminal.sendInput(seq);
			await this.pause();
		}
	}

	/**
	 * Type a string of characters one by one.
	 */
	async typeText(text: string): Promise<void> {
		for (const ch of text) {
			this.terminal.sendInput(ch);
		}
		await this.pause();
	}

	/**
	 * Click a widget matched by CSS selector or at explicit `{ x, y }` coordinates.
	 */
	async click(selectorOrCoords: string | { x: number; y: number }): Promise<void> {
		if (typeof selectorOrCoords === "string") {
			const widget = this.app.queryOne(selectorOrCoords);
			if (widget.canFocus && !widget.disabled) {
				widget.focus();
			}
			widget.dispatchMessageSync(new ClickEvent(0, 0, {}, widget));
			this.app.requestRender();
			await this.pause();
			return;
		}
		const { x, y } = selectorOrCoords;
		const pressSeq = `\x1b[<0;${x + 1};${y + 1}M`;
		const releaseSeq = `\x1b[<0;${x + 1};${y + 1}m`;
		this.terminal.sendInput(pressSeq);
		this.terminal.sendInput(releaseSeq);
		await this.pause();
	}

	/**
	 * Resize the virtual terminal and notify the app.
	 */
	async resize(columns: number, rows: number): Promise<void> {
		this.terminal.resize(columns, rows);
		this.app.handleResize(columns, rows);
		await this.pause();
	}

	/**
	 * Flush async message queues and scheduled TUI renders.
	 */
	async pause(): Promise<void> {
		await this.app.flushMessages();
		await this.app.screen.flushMessages();
		for (const w of this.app.screen.walkChildren()) {
			await w.flushMessages();
		}
		await new Promise<void>((resolve) => process.nextTick(resolve));
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
	}

	/**
	 * Get the current rendered screen lines (with ANSI styling).
	 */
	getScreenLines(): string[] {
		const rendered = this.app.tui.render(this.terminal.columns);
		if (rendered.length > 0) {
			return rendered;
		}
		return this.terminal.getViewportLines();
	}

	/**
	 * Get the plain-text (ANSI-stripped) screen output joined by newlines.
	 */
	getPlainScreenText(): string {
		const fromTui = this.getScreenLines()
			.map((line) => stripAnsi(line).trimEnd())
			.join("\n");
		const fromTerm = this.terminal
			.getViewportLines()
			.map((line) => stripAnsi(line).trimEnd())
			.join("\n");
		return fromTerm.trim().length >= fromTui.trim().length ? fromTerm : fromTui;
	}

	/**
	 * Stop the app and clean up the pilot session.
	 */
	async exit(): Promise<void> {
		this.app.stop();
	}
}

export async function createPilot<TApp extends App<any>>(
	app: TApp,
	options?: { columns?: number; rows?: number },
): Promise<Pilot<TApp>> {
	const cols = options?.columns ?? 80;
	const rows = options?.rows ?? 24;
	const vterm = new VirtualTerminal(cols, rows);
	(app as unknown as { terminal: Terminal; _usesDefaultProcessTerminal: boolean }).terminal = vterm;
	(app as unknown as { _usesDefaultProcessTerminal: boolean })._usesDefaultProcessTerminal = false;
	(app.tui as unknown as { terminal: Terminal }).terminal = vterm;

	const pilot = new Pilot(app, vterm);
	app.start();
	await pilot.pause();
	return pilot;
}
