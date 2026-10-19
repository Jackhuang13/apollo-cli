---
name: agent-observe
description: Inspect live subagent status, recent activity, and transcripts from the TypeScript REPL (`import { list_subagents, inspect_subagent } from "agent_observe"`).
---

# `agent-observe` — Subagent Observation & Diagnostics

Observe active and completed subagents, inspect their recent progress, and collect results.

## Import

```ts
import { list_subagents, inspect_subagent } from "agent_observe";
```

## Usage

```ts
const agents = await list_subagents();
console.log(agents);

// Or via global rlm helper:
const all = await rlm.list_subagents();
```
