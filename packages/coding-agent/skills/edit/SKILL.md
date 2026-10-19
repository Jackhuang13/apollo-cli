---
name: edit
description: Surgical exact-text file replacements with automatic diff display in the TUI. Import via `import { edit, EditError } from "edit"` when modifying existing files.
---

# `edit` — Surgical File Editing

Make exact text replacements in existing files and emit a unified diff to the TUI.

## Import

```ts
import { edit, EditError } from "edit";
```

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

## Batch Replacements (Atomic)

Apply multiple sequential edits to the same file in a single atomic write:

```ts
edit("src/server.ts", [
  { old: "const PORT = 8000;", new: "const PORT = 8080;" },
  { old: "const DEBUG = false;", new: "const DEBUG = true;" },
]);
```

If any entry fails to match, the entire call throws `EditError` and the file on disk is left untouched.

## Viewing Before Editing

Use `rlm.view("path/to/file.ts", { start: 1, end: 120 })` to inspect lines before calling `edit(...)`.
