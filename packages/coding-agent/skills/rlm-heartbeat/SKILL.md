---
name: rlm-heartbeat
description: Periodic orchestration heartbeat workflow for monitoring background subagents, collecting finished outputs, and emitting concise progress notes (`import { check_subagents, report_progress } from "rlm_heartbeat"`).
---

# `rlm-heartbeat` — Orchestration Heartbeat

Monitor active background subagents, collect completed work, intervene on stalled or failed workers, and emit concise progress updates.

## Import

```ts
import { check_subagents, report_progress } from "rlm_heartbeat";
```

## Usage

```ts
const summary = await check_subagents();
await report_progress(`Subagents: ${summary.completed}/${summary.total} complete (${summary.running} running)`);
```
