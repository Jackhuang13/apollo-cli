---
name: compact
description: Inspect context-window usage and schedule session compaction when the conversation approaches the context limit. Import via `import compact, { status, run } from "compact"`.
---

# `compact` — Context Compaction Management

Check token utilization and schedule session compaction at natural task boundaries.

## Import

```ts
import compact, { status, run } from "compact";
```

## Check Context Usage

```ts
const info = await status(); // { tokens, context_window, percent, scheduled }
console.log(info.percent, info.scheduled);
```

## Schedule Compaction

```ts
await run("Preserve current file paths, open TODOs, and test failure root causes.");
```

Compaction runs cleanly after the current turn completes while preserving your live REPL variables.
