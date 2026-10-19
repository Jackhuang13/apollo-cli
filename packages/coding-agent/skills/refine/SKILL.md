---
name: refine
description: Schedule and inspect continual harness refinement from the TypeScript REPL (`import refine, { run, status } from "refine"`), plus thin wrappers over the real `harness` CRUD methods.
---

# `refine` — Continual Harness Refinement

Schedule a harness refinement (applied at the turn boundary) and inspect or edit durable harness entries.

## Import

```ts
import refine, { run, status } from "refine";
```

## Schedule Refinement

```ts
await run("Record the retry policy as a memory", /* global_ */ false);
await run("Always verify with the project's own interpreter", /* global_ */ true);
const s = await status(); // { pending, in_flight }
```

## Harness Access

`harness` is pre-loaded on `globalThis`; `refine` also exposes thin wrappers over the real `HarnessState` methods. Scope is `local` (session) by default; pass `{ global_: true }` for the cross-session store.

```ts
harness.overview();
harness.search("verification");
refine.create_memory("title", "content", { global_: true });
refine.update_memory(id, "title", "content");
refine.delete_memory(id);
refine.create_prompt_note("title", "content");
refine.create_skill("title", "content", { reference: {}, arguments: {} });
refine.create_subagent("title", "content");
refine.record_refinement("why", ["memory:global:..."], { global_: true });
```
