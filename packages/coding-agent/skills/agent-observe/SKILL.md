---
name: agent-observe
description: Read-only observation of your agent family (parent, siblings, children) from the TypeScript REPL (`import agent_observe from "agent_observe"`).
---

# `agent-observe` — Family Observation

Read live session summaries and bounded recent message previews for your agent family.

## Import

```ts
import agent_observe from "agent_observe";
```

## Usage

```ts
const family = await agent_observe.list_agents();
const one = await agent_observe.get("parent");
const recent = await agent_observe.recent("child", 8, 800);
```
