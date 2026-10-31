---
name: edit
description: Surgical exact-text file replacements with automatic diff display in the TUI. Import via `import { edit, EditError } from "edit"` when modifying existing files.
---

# `edit` — Surgical File Editing

Make surgical text replacements in existing files and emit a unified diff to the TUI. Only the matched region is ever rewritten; every other byte of the file (CRLF line endings, trailing whitespace, non-ASCII normalization forms) is preserved exactly.

## Import

```ts
import { edit, EditError } from "edit";
```

## Matching Order (count=1)

1. **Exact** — `old` matches the file byte-for-byte.
2. **Escape repair** — if `old` contains escape-prone backslash sequences (literal `\n`, `\t`, `\r`, `\\`, `\``, `\${`, `\'`, `\"`), one unescaped candidate is tried and adopted **only when it matches exactly once**. The result is marked `repaired: true` and the TUI shows "(auto-repaired escape sequences)". A candidate with multiple hits fails loudly with the occurrence count. `new` is **never** auto-unescaped.
3. **Fuzzy locate** — tolerant matching for cosmetic differences only: NFKC normalization, trailing whitespace per line, curly/smart quotes to straight quotes, Unicode dashes to hyphen, special spaces (NBSP and similar) to space. The match is used **only to locate** the region; the splice is applied to the original text and the diff payload's `old_str` is the actual original slice. A fuzzy match must also be unique.
4. **Loud failure** — if nothing matches, the `EditError` keeps the `Could not find the exact text` prefix and appends diagnostics: the closest file line with a similarity score, the character-level first diff with file line/col, and a copyable exact file window to use as the next `old`.

The `count > 1` / `count = 0` (replace-all) paths stay **pure exact**; their not-found error adds a hint when an unescaped candidate would have matched.

## Single Replacement

```ts
edit("src/config.ts", "const TIMEOUT = 30;", "const TIMEOUT = 60;");
```

`old` must match a **single** location in the file by default. If `old` is not found or matches multiple locations, `edit` throws `EditError` without touching the file.

To replace multiple occurrences intentionally, pass `{ count }` (or `0` for all occurrences):

```ts
edit("src/config.ts", "oldName", "newName", { count: 3 }); // must match 3 times
edit("src/config.ts", "oldName", "newName", { count: 0 }); // replace every match
```

## Result Shape

`edit(...)` returns `{ path, replacements, diff, firstChangedLine?, repaired?, warning? }`.

- `repaired: true` — at least one `old` text was applied via escape repair.
- `warning` — advisory: your `new` text still contains literal escape sequences that were unescaped in `old`; verify the new text is what you intended.

## Batch Replacements (Atomic)

Apply multiple sequential edits to the same file in a single atomic write:

```ts
edit("src/server.ts", [
  { old: "const PORT = 8000;", new: "const PORT = 8080;" },
  { old: "const DEBUG = false;", new: "const DEBUG = true;" },
]);
```

If any entry fails to match, the entire call throws `EditError` and the file on disk is left untouched.

## Known pitfall: String.raw

`String.raw` keeps backslashes literal, so an `old` built inside `String.raw` usually carries stray backslashes (literal `\n`, a backslash before a backtick, before `\${`). The tool auto-repairs `old` one-way (matching order step 2), but a `new` written inside `String.raw` writes those literal sequences **into the file**. Prefer:

- copying `old` verbatim from `rlm.view` output or a `readFileSync` slice, or
- plain template literals / normal strings for both `old` and `new`.

## Viewing Before Editing

Use `rlm.view("path/to/file.ts", { start: 1, end: 120 })` to inspect lines before calling `edit(...)`.
