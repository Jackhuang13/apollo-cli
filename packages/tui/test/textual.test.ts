import assert from "node:assert";
import { describe, it } from "vitest";
import {
	App,
	Binding,
	ClickEvent,
	Collapsible,
	calculateSpecificity,
	defineReactive,
	Footer,
	Grid,
	Header,
	Horizontal,
	type InputChanged,
	InputSubmitted,
	KeyEvent,
	Label,
	LoadingIndicator,
	Message,
	ModalScreen,
	MountEvent,
	OptionList,
	type OptionSelected,
	parseSelector,
	Region,
	ResizeEvent,
	Rule,
	reactive,
	Screen,
	ScrollableContainer,
	Size,
	Static,
	Strip,
	Stylesheet,
	type TabActivated,
	TabbedContent,
	TabPane,
	TextArea,
	TextualInput,
	TextualMarkdown,
	UnmountEvent,
	Vertical,
	Widget,
} from "../src/index.js";

describe("Textual Message & MessagePump", () => {
	it("computes snake_case handlerName and supports stop() and preventDefault()", () => {
		const keyEvt = new KeyEvent("a", "a", "a");
		assert.strictEqual(keyEvt.handlerName, "key");
		assert.strictEqual(keyEvt.stopped, false);
		assert.strictEqual(keyEvt.defaultPrevented, false);

		keyEvt.stop();
		keyEvt.preventDefault();
		assert.strictEqual(keyEvt.stopped, true);
		assert.strictEqual(keyEvt.defaultPrevented, true);

		const submitted = new InputSubmitted("hello", null);
		assert.strictEqual(submitted.handlerName, "input_submitted");

		class CustomAction extends Message {
			constructor() {
				super({ namespace: "editor" });
			}
		}
		const custom = new CustomAction();
		assert.strictEqual(custom.handlerName, "editor_custom_action");
	});

	it("bubbles messages up DOM hierarchy and invokes on_<handlerName> methods", async () => {
		const trace: string[] = [];

		class ChildWidget extends Static {
			on_input_submitted(msg: InputSubmitted): void {
				trace.push(`child:${msg.value}`);
			}
		}

		class ParentBox extends Vertical {
			on_input_submitted(msg: InputSubmitted): void {
				trace.push(`parent:${msg.value}`);
				msg.stop();
			}
		}

		class RootScreen extends Screen {
			on_input_submitted(msg: InputSubmitted): void {
				trace.push(`screen:${msg.value}`);
			}
		}

		const screen = new RootScreen();
		const parent = new ParentBox();
		const child = new ChildWidget("leaf");
		parent.mount(child);
		screen.mount(parent);

		await child.dispatchMessage(new InputSubmitted("ping", child));
		assert.deepStrictEqual(trace, ["child:ping", "parent:ping"]);
	});
});

describe("Textual Reactive System", () => {
	it("calls validate_<prop>, watch_<prop>, compute_<prop>, and triggers refresh()", () => {
		const watchCalls: Array<[number, number]> = [];
		let refreshCount = 0;

		class CounterWidget extends Widget {
			declare count: number;
			declare doubled: number;
			multiplier = reactive(3);

			constructor() {
				super();
				defineReactive(this, "count", 0, { layout: true });
				defineReactive(this, "doubled", 0);
			}

			validate_count(val: number): number {
				return Math.max(0, Math.min(100, val));
			}

			watch_count(oldVal: number, newVal: number): void {
				watchCalls.push([oldVal, newVal]);
			}

			compute_doubled(): number {
				return this.count * 2;
			}

			override refresh(): void {
				refreshCount += 1;
			}
		}

		const w = new CounterWidget();
		w.ensureComposed();
		assert.strictEqual(w.count, 0);
		assert.strictEqual(w.doubled, 0);

		w.count = 15;
		assert.strictEqual(w.count, 15);
		assert.strictEqual(w.doubled, 30);
		assert.deepStrictEqual(watchCalls, [[0, 15]]);
		assert.ok(refreshCount >= 1);

		// Clamped by validate_count
		w.count = 250;
		assert.strictEqual(w.count, 100);
		assert.strictEqual(w.doubled, 200);
		assert.deepStrictEqual(watchCalls, [
			[0, 15],
			[15, 100],
		]);
	});
});

describe("TCSS Parser, Specificity, and Cascade", () => {
	it("parses selectors, calculates specificity, resolves theme variables, and cascades rules", () => {
		const s1 = parseSelector("Static");
		assert.deepStrictEqual(s1.specificity, [0, 0, 1]);

		const s2 = parseSelector("Vertical > Static.highlight:focus");
		assert.deepStrictEqual(s2.specificity, [0, 2, 2]);

		const s3 = parseSelector("#main-panel .item#hero");
		assert.deepStrictEqual(s3.specificity, [2, 1, 0]);
		assert.ok(calculateSpecificity(s3.steps)[0] > calculateSpecificity(s2.steps)[0]);

		const sheet = new Stylesheet({ $brand: "#ff0055" });
		sheet.parse(`
			$pad: 2;
			Static {
				color: #aaaaaa;
				padding: 1;
				border: solid $brand;
			}
			Vertical > .card {
				color: #00ff00;
				padding: $pad;
				text-style: bold italic;
			}
			#special {
				width: 50%;
				border-title: "Hero";
			}
		`);

		const container = new Vertical();
		const card = new Static("Hello", { id: "special", classes: "card" });
		container.mount(card);

		const computed = sheet.computeStyles(card);
		assert.strictEqual(computed.color, "#00ff00");
		assert.deepStrictEqual(computed.padding, [2, 2, 2, 2]);
		assert.strictEqual(computed.borderStyle, "solid");
		assert.strictEqual(computed.borderColor, "#ff0055");
		assert.strictEqual(computed.borderTitle, "Hero");
		assert.strictEqual(computed.textStyle?.bold, true);
		assert.strictEqual(computed.textStyle?.italic, true);
		assert.deepStrictEqual(computed.width, { value: 50, unit: "percent" });
	});
});

describe("DOMNode, DOMQuery, and Widget Box Model", () => {
	it("queries descendants with complex selectors and applies bulk mutations", () => {
		const root = new Vertical({ id: "root" });
		const a = new Static("One", { id: "first", classes: "item primary" });
		const b = new Static("Two", { id: "second", classes: "item" });
		const nested = new Horizontal(new Label("Three", { id: "third", classes: "item" }));
		root.mount(a, b, nested);

		const items = root.query(".item");
		assert.strictEqual(items.length, 3);
		assert.strictEqual(items.first(), a);
		assert.strictEqual(items.last().id, "third");

		const directItems = root.query("Vertical > .item");
		assert.strictEqual(directItems.length, 2);

		directItems.addClass("tagged");
		assert.strictEqual(a.hasClass("tagged"), true);
		assert.strictEqual(b.hasClass("tagged"), true);
		assert.strictEqual(root.queryOne("#third").hasClass("tagged"), false);
	});

	it("renders Widget with border, borderTitle, padding, margin, and alignment", () => {
		const box = new Static("Hi");
		box.styles.width = 12;
		box.styles.border = ["round", "#38bdf8"];
		box.borderTitle = "Box";
		box.styles.padding = [1, 1, 1, 1];
		box.styles.textAlign = "center";

		const lines = box.render(20);
		assert.strictEqual(lines.length, 5); // top border + 1 padTop + 1 content + 1 padBottom + bottom border
		assert.ok(lines[0]!.includes("╭"));
		assert.ok(lines[0]!.includes("Box"));
		assert.ok(lines[4]!.includes("╰"));

		const r = new Region(2, 3, 10, 5);
		assert.strictEqual(r.contains(5, 5), true);
		assert.strictEqual(r.contains(15, 5), false);
		assert.ok(r.size.equals(new Size(10, 5)));

		const strip = new Strip("abcdef").crop(1, 4).pad(5);
		assert.strictEqual(strip.text, "bcd  ");
		assert.strictEqual(strip.cellLength, 5);
	});
});

describe("Textual App, Pilot, Layouts, Screens, and Built-in Widgets", () => {
	it("runs a full App via Pilot with Header, Footer, bindings, TabbedContent, OptionList, Input, and ModalScreen", async () => {
		const events: string[] = [];

		class ConfirmModal extends ModalScreen<boolean> {
			static override BINDINGS = [new Binding("y", "confirm_yes", "Yes"), new Binding("n", "confirm_no", "No")];

			override *compose(): Iterable<Widget> {
				yield new Label("Confirm action? (y/n)", { id: "modal-prompt" });
			}

			action_confirm_yes(): void {
				this.dismiss(true);
			}

			action_confirm_no(): void {
				this.dismiss(false);
			}
		}

		class TestApp extends App<string> {
			static override TITLE = "Prime Textual";
			static override SUB_TITLE = "Test Suite";
			static override CSS = `
				#banner {
					border: solid $accent;
					padding: 0 1;
				}
				#grid-box {
					grid-size: 2;
					grid-gutter: 0 2;
				}
			`;
			static override BINDINGS = [new Binding("ctrl+b", "ping", "Ping Action")];

			modalResult: boolean | null = null;

			override *compose(): Iterable<Widget> {
				yield new Header();
				yield new Static("Welcome Banner", { id: "banner" });
				yield new Grid(new Label("Cell A", { id: "cell-a" }), new Label("Cell B", { id: "cell-b" }), {
					id: "grid-box",
				});
				yield new Collapsible("Details", new Label("Hidden body", { id: "details-body" }), {
					id: "details",
					collapsed: true,
				});
				yield new TabbedContent(
					new TabPane("One", new Label("Pane 1 Content"), { id: "pane-1" }),
					new TabPane("Two", new Label("Pane 2 Content"), { id: "pane-2" }),
					{ id: "tabs" },
				);
				yield new TextualInput({ id: "name-input", placeholder: "Enter name" });
				yield new OptionList(
					[
						{ value: "opt1", label: "Alpha" },
						{ value: "opt2", label: "Beta" },
					],
					{ id: "options" },
				);
				yield new ScrollableContainer(new Static("Line 1\nLine 2\nLine 3\nLine 4\nLine 5"), { id: "scroller" });
				yield new Rule({ lineStyle: "double" });
				yield new TextualMarkdown("**Bold Markdown**", { id: "md" });
				yield new TextArea("initial text", { id: "textarea" });
				yield new LoadingIndicator("Working...", { id: "loader" });
				yield new Footer();
			}

			action_ping(): void {
				events.push("ping");
			}

			on_input_changed(msg: InputChanged): void {
				events.push(`changed:${msg.value}`);
			}

			on_input_submitted(msg: InputSubmitted): void {
				events.push(`submitted:${msg.value}`);
			}

			on_option_selected(msg: OptionSelected): void {
				events.push(`option:${msg.optionId}:${msg.index}`);
			}

			on_tab_activated(msg: TabActivated): void {
				events.push(`tab:${msg.tabId}`);
			}
		}

		const app = new TestApp();
		let mountedFired = false;
		let unmountedFired = false;
		let resizedDims = "";
		app.screen.on(MountEvent, () => {
			mountedFired = true;
		});
		app.screen.on(ResizeEvent, (e) => {
			resizedDims = `${e.width}x${e.height}`;
		});

		const pilot = await app.runTest({ columns: 80, rows: 35 });
		try {
			assert.strictEqual(mountedFired, true);
			const plain = pilot.getPlainScreenText();
			assert.ok(plain.includes("Prime Textual"));
			assert.ok(plain.includes("Welcome Banner"));
			assert.ok(plain.includes("Cell A"));
			assert.ok(plain.includes("Cell B"));
			assert.ok(plain.includes("Bold Markdown"));

			// Trigger app binding ctrl+b -> action_ping
			await pilot.press("ctrl+b");
			assert.ok(events.includes("ping"));

			// Expand Collapsible via focus + enter
			const collapsible = app.queryOne<Collapsible>("#details");
			collapsible.focus();
			assert.strictEqual(collapsible.collapsed, true);
			await pilot.press("enter");
			assert.strictEqual(collapsible.collapsed, false);
			assert.ok(pilot.getPlainScreenText().includes("Hidden body"));

			// Switch tab in TabbedContent
			const tabs = app.queryOne<TabbedContent>("#tabs");
			tabs.focus();
			await pilot.press("right");
			assert.strictEqual(tabs.active, "pane-2");
			assert.ok(events.includes("tab:pane-2"));
			assert.ok(pilot.getPlainScreenText().includes("Pane 2 Content"));

			// Type into TextualInput and submit
			const input = app.queryOne<TextualInput>("#name-input");
			input.focus();
			await pilot.typeText("Neo");
			await pilot.press("enter");
			assert.strictEqual(input.value, "Neo");
			assert.ok(events.includes("changed:Neo"));
			assert.ok(events.includes("submitted:Neo"));

			// Navigate OptionList and select second option
			const optionList = app.queryOne<OptionList>("#options");
			optionList.focus();
			await pilot.press("down", "enter");
			assert.ok(events.includes("option:opt2:1"));

			// Scroll ScrollableContainer
			const scroller = app.queryOne<ScrollableContainer>("#scroller");
			scroller.styles.height = 2;
			scroller.focus();
			await pilot.press("down");
			assert.strictEqual(scroller.scrollY, 1);

			// Click event via pilot.click(selector)
			let clickedBanner = false;
			const banner = app.queryOne("#banner");
			banner.on(ClickEvent, () => {
				clickedBanner = true;
			});
			await pilot.click("#banner");
			assert.strictEqual(clickedBanner, true);

			// Push ModalScreen and resolve via key press 'y'
			const modalPromise = app.pushScreen(new ConfirmModal());
			await pilot.pause();
			await pilot.press("y");
			const modalRes = await modalPromise;
			assert.strictEqual(modalRes, true);

			// Theme switching & notifications & clipboard
			app.registerTheme("custom-theme", { $accent: "#00ffaa" });
			app.theme = "custom-theme";
			assert.strictEqual(app.theme, "custom-theme");

			app.notify("Saved!", { title: "Info", timeout: 0 });
			assert.strictEqual(app.lastNotification?.message, "Saved!");

			app.copyToClipboard("copied-value");
			assert.strictEqual(app.clipboard, "copied-value");

			// Resize event
			await pilot.resize(100, 40);
			assert.strictEqual(resizedDims, "100x40");

			// Unmount event check
			banner.on(UnmountEvent, () => {
				unmountedFired = true;
			});
			banner.remove();
			assert.strictEqual(unmountedFired, true);
		} finally {
			await pilot.exit();
		}
	});
});
