---
name: compact
description: Inspect context-window usage and schedule session compaction when the conversation approaches the context limit. Import via `import { compact } from "compact"`.
---

# `compact` — Context Compaction Management

Check token utilization and schedule session compaction at natural task boundaries.

## Import

```ts
import { compact } from "compact";
```

## Check Context Usage

```ts
const info = await compact.status();
console.log(info.percent, info.should_compact);
```

## Schedule Compaction

```ts
await compact.request("Preserve current file paths, open TODOs, and test failure root causes.");
```

Compaction runs cleanly after the current turn completes while preserving your live TypeScript REPL variables.
