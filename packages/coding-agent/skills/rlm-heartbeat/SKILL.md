---
name: rlm-heartbeat
description: Manage internal recurring RLM heartbeats for the current agent session (list, create, update, delete) from the TypeScript REPL (`import rlm_heartbeat from "rlm_heartbeat"`).
---

# `rlm-heartbeat` — Internal Session Heartbeats

Create and manage internal recurring heartbeats that fire within the current agent session. These never touch the user-level `/heartbeat`.

## Import

```ts
import rlm_heartbeat from "rlm_heartbeat";
```

## Usage

```ts
await rlm_heartbeat.create("check the long test run", "5m", "tests", "follow_up");
const all = await rlm_heartbeat.list(true);
await rlm_heartbeat.update("job-1", undefined, undefined, undefined, "pause");
await rlm_heartbeat.delete("job-1");
```
