# Textual TUI Framework

The "Texture TUI" (discussion nickname — the word *texture* does not appear anywhere in the
codebase) is the TypeScript **Textual-style framework layer** at `packages/tui/src/textual/`.
It is a deliberate, terminal-only rewrite of Python [Textual](https://github.com/Textualize/textual)'s
DOM/CSS/compositor model, layered **on top of** the classic differential-rendering TUI
(`packages/tui/src/tui.ts`) — not a replacement for it.

## Current state

- The whole layer is exported from the package root: `packages/tui/src/index.ts`
  (`export * from "./textual/index.js"`). No new dependencies were added.
- **The coding-agent interactive mode does not use it yet.** `modes/interactive/interactive-mode.ts`
  imports only classic `TUI`/`Component`/`Container` types, and the ~70 files under
  `modes/interactive/components/` all implement the classic `Component` interface.
- The layer's only consumer today is `packages/tui/test/textual.test.ts` (Pilot-driven: message
  bubbling, reactive hooks, CSS specificity, input into widgets, modal/tab/scroll behavior).

So the Textual layer is a **library capability** available to extensions and to a future
interactive-mode migration; it is not the active rendering engine.

## Module map

| File | Responsibility |
|---|---|
| `textual/app.ts` | `App extends DOMNode`: lifecycle (`compose()`, `start()`, `run()`, `stop()`, `exit()`), screen stack (`pushScreen`/`popScreen`/`switchScreen`), themes (`registerTheme`, built-in `textual-dark`/`textual-light`), `notify()` toasts, `runAction("name(args)")`, `runTest()` (headless Pilot). Wraps a classic `TUI` internally. |
| `textual/dom.ts` | `DOMNode extends MessagePump`: id/classes/inline styles, parent/children, pseudo-class support, `query()`/`queryOne()` → `DOMQuery`, class mutation → `refreshStyles()` from the app stylesheet. |
| `textual/css/parser.ts` | Textual-style CSS subset: `parseSelector`, `matchesSelector`, `calculateSpecificity` ((id, class, step) tuple), `parseDeclarations`, `Stylesheet` (regex-based parse of `$var: ...` + `selector { ... }` blocks; specificity-ordered cascade). |
| `textual/css/styles.ts` | `Styles`/`StyleProperties` (display, layout, dock, border, margin, padding, width/height/min/max, alignment, grid), scalar system (`auto`/number/`fr`/`%`), box spacing, color → ANSI (`fgAnsi`/`bgAnsi`), `DEFAULT_DARK_THEME`/`DEFAULT_LIGHT_THEME` theme variables. |
| `textual/compositor.ts` | `Compositor` (static): dock top → (left \| flow \| right) → dock bottom; flow layout via vertical (fr heights), horizontal (default 1fr widths), or grid; `joinColumns`. |
| `textual/layout.ts` | `Size`/`Offset`/`Region`/`Strip` (rendered rows), `resolveFlexibleSizes` (auto → intrinsic, then `fr` share of remaining space), `partitionDockedChildren`. |
| `textual/reactive.ts` | `reactive()`/`defineReactive()` properties with `compute_<prop>` getters, `validate_<prop>`/`watch_<prop>(old, new)` setters; changes trigger `refresh({layout, repaint})`. |
| `textual/messages.ts` | `Message`/`Event`/`MessagePump`: async bubbling dispatch to `on_<name>` handlers, `stop()`/`preventDefault()`, `postMessage` (microtask queue). Events: `KeyEvent`, `ClickEvent`, `ResizeEvent`, `FocusEvent`, `BlurEvent`, mount/unmount; messages: `InputSubmitted`, `InputChanged`, `OptionSelected`, `TabActivated`. |
| `textual/screen.ts` | `Screen`/`ModalScreen`; `toFullscreenOptions()` maps Textual dock semantics onto classic `FullscreenOptions` (`pin`/`scroll`/`dock`). |
| `textual/widget.ts` | `Widget implements Component, Focusable`: `render()` returns `string[]` rows (the classic contract), box model (margin/border/padding/display/alignment) applied in render, click regions aggregated for the classic mouse pipeline, `static DEFAULT_CSS` auto-registered. |
| `textual/binding.ts` | `Binding` (key, action, description, priority, optional `id: Keybinding` wired to the classic `KeybindingsManager`, so keys stay configurable). Resolution order: priority bindings (screen/app) → focused widget → non-priority app bindings. |
| `textual/pilot.ts` | `VirtualTerminal` (in-memory screen buffer) + `Pilot` (`press`, `typeText`, `click`, `resize`, `pause`, `getScreenLines`, `getPlainScreenText`) — the headless test driver, mirroring Textual's `run_test()` + `Pilot`. |
| `textual/widgets/index.ts` | Widget set (see below). |
| `textual/index.ts` | Barrel export; everything is re-exported from the package root. |

## Bridge to the classic TUI (coexistence points)

- `Widget implements Component, Focusable` — any Textual widget can be mounted directly into the
  classic `TUI`/`Container`.
- `App` constructs `this.tui = new TUI(this.terminal)` internally; `App.start()` swaps the
  current `Screen` into the classic TUI and enters fullscreen; `ModalScreen` uses
  `tui.showOverlay`.
- `Binding` defers to the classic `KeybindingsManager` when given a binding `id`
  (AGENTS.md requires configurable keys — no hardcoded key strings).
- `Widget.render()` produces classic `string[]` output; the compositor's regions feed it.

This coexistence is what makes an **incremental migration** possible: new flows or modals can run
inside a Textual `App` while the existing transcript stays classic `Component`s embedded in a
`Screen`.

## Widget inventory

| Purpose | Classic component (in use today) | Textual wrapper (exists, unused by coding-agent) |
|---|---|---|
| Single-line input | `components/input.ts` `Input` | `TextualInput` (emits `InputChanged`/`InputSubmitted`) |
| Multi-line editor | `components/editor.ts` `Editor` | `TextArea` |
| Selection list | `components/select-list.ts` `SelectList` | `OptionList` (emits `OptionSelected`) |
| Markdown | `components/markdown.ts` `Markdown` | `TextualMarkdown` |
| Loader | `components/loader.ts` `Loader` | `LoadingIndicator` |
| Containers/display | — | `Static`, `Label`, `Vertical`, `Horizontal`, `Grid`, `ScrollableContainer`, `VerticalScroll`, `Header`, `Footer`, `Rule`, `Collapsible`, `TabbedContent`/`TabPane` |

The remaining ~65 interactive components (conversation messages, tool execution, selectors,
menus, splash, agents view, ...) have **no Textual counterpart yet** and would need to be written
during a migration. `IScriptCellComponent` (`modes/interactive/components/iscript-cell.ts`) would
become an `IScriptCellWidget` (see the blueprint below).

The `Textual*` name prefix on wrappers avoids export-name collisions with the classic components
at the package root — keep the prefix when adding wrappers.

## CSS subset

Supported: id/class/type/descendant selectors, pseudo-classes `:focus` `:focus-within` `:hover`
`:disabled` `:enabled`, specificity-ordered cascade, `$theme-var` references, `display`,
`layout: vertical|horizontal|grid`, `dock: top|bottom|left|right`, `fr` sizing, box model
(margin/padding/border/alignment), grid columns/gutter, colors → ANSI.

Not supported (as of the current tree; verify against `css/parser.ts` before relying on any of
these): child combinator `>`, sibling `~`, attribute selectors, media queries. The parser is a
simplified TCSS rewrite (regex over top-level `$var` declarations and selector blocks), not the
full Textual CSS grammar.

## The `apollo.tcss` blueprint (not wired)

`src/modes/interactive/theme/apollo.tcss` ("Apollo CLI Textual CSS Stylesheet") is an **orphan
file**: nothing in the repo loads or references it. It styles classes that do not exist yet —
`InteractiveScreen`, `AgentsViewScreen`, `IScriptCellWidget` (with `.running`/`.success`/
`.error` state classes) and ids `#top-bar`, `#transcript-scroll`, `#dock-bottom`,
`#editor-container`, `#footer`, `.modal-dialog`. It is the planned target layout for a
Textual-based interactive mode:

```
#top-bar        dock: top, height 1
#transcript-scroll  1fr, scrollable
#dock-bottom    dock: bottom (contains #editor-container)
#footer
.modal-dialog
```

To activate it: create the matching `InteractiveScreen`/`AgentsViewScreen`/`IScriptCellWidget`
classes (so the type selectors can match) and convert the JSON theme colors
(`theme/apollo.json` / `apollo-dark.json` / `apollo-light.json`) into Textual `ThemeVariables`
for `App.registerTheme(...)` — the JSON color structure is not the `$var` format as-is.

## Recipes for adjusting the TUI

**Add a Textual widget**

1. `class MyWidget extends Widget` in `packages/tui/src/textual/widgets/` (inline in
   `index.ts` or its own file + barrel). Add `static DEFAULT_CSS` for styling (auto-registered
   on compose).
2. Re-export from `packages/tui/src/textual/index.ts`; the package root picks it up via
   `export *`. Prefix wrapper names with `Textual` to avoid classic-name collisions.
3. Test with the Pilot pattern in `packages/tui/test/textual.test.ts`
   (`createPilot`, `press`/`typeText`, `getPlainScreenText`).

**Change styling**

- New CSS property: add to `StyleProperties` + parsing in `css/styles.ts`, and
  `parseDeclarations` in `css/parser.ts` if the parser must accept it.
- Theme variables: `DEFAULT_DARK_THEME`/`DEFAULT_LIGHT_THEME` or runtime
  `app.registerTheme(name, vars)`.
- App-level CSS cascade order: widget CSS → screen CSS → app `static CSS`/`AppOptions.css` →
  extra CSS (`app.ts` `rebuildStylesheet`).

**Add a keyboard binding**

- `static BINDINGS` on the App/Screen/Widget subclass; for a configurable key use
  `{ id: <Keybinding> }` so the classic `KeybindingsManager` (and the user's keybinding
  overrides) win. Never hardcode a key string (AGENTS.md).
- Default bindings: `Screen` binds tab/shift+tab to focus navigation; `ModalScreen` binds
  escape to dismiss.

**Change layout/geometry**

- Size/region math: `layout.ts` (`resolveFlexibleSizes`, `Region`, `Strip`).
- Dock/grid arrangement: `compositor.ts`.
- Box model (margin/border/padding/alignment) applied in `widget.ts` `render()`.

## Migrating the interactive mode (the unfinished step)

`interactive-mode.ts` is ~12,600 lines with a wide classic-TUI surface (fullscreen, overlays,
mouse, clipboard, keybindings, ~65 components). The migration path implied by the current
design:

1. Define `InteractiveScreen` (top-bar / transcript / editor dock / footer) per `apollo.tcss`.
2. Wrap or rewrite components as Widgets; `IScriptCellComponent` → `IScriptCellWidget` with
   reactive state and `.running`/`.success`/`.error` classes.
3. Convert the JSON themes to `ThemeVariables`.
4. Exploit the bridge for incremental rollout: new dialogs/modals in a Textual `App` first,
   classic transcript embedded in the `Screen` until the rest is ported.

## References

- Python Textual (design reference): https://github.com/Textualize/textual —
  the fork mirrors `App.run()`/`run_test()`+`Pilot`, `compose()`, TCSS (subset), reactives,
  message bubbling, `BINDINGS`; it deliberately drops the full CSS grammar, compositor scroll
  machinery, and web serving.
- Classic differential-rendering TUI (still the active engine): [TUI components](tui.md).
