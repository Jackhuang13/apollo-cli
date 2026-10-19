---
name: goal
description: Manage the persistent thread goal from the kernel. Use to read the goal's status and budget usage, to start a goal when the user explicitly asks for one, or to mark the active goal complete once its objective is fully achieved.
---

# `goal` — Persistent Thread Goal

All goal state lives in the host. These functions are thin typed clients over the
generic host bridge; call them from the kernel only.

## Import

```ts
import goal from "goal";
// or: import { get, create, complete } from "goal";
```

## Usage

```ts
// Read the current goal (null when none is set).
const { goal: active, remaining_tokens } = await get();

// Start a goal only when the user (or system/developer instructions) explicitly
// ask for a persistent long-running goal.
await create("Migrate authentication middleware to JWT v2");

// Mark the goal achieved once the objective is fully done and no required
// work remains — not because the budget is nearly exhausted.
await complete();
```

- `get()` returns `{ goal, remaining_tokens, completion_budget_report }`. The
  `goal` object carries the objective, status, token budget, and token/elapsed
  usage; it is `null` when no goal is active.
- `create(objective, tokenBudget?)` fails while a goal is still pending
  (active, paused, or budget-limited); a completed or errored goal is replaced.
  Pass `tokenBudget` only when an explicit token budget is requested.
- `complete()` reports the completion budget usage. Pause, resume, and
  budget-limit transitions are controlled by the user and the host.
