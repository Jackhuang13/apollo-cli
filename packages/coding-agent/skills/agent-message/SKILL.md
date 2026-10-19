---
name: agent-message
description: Emit a prominent user-facing markdown message block directly from a TypeScript REPL cell (`import { agent_message } from "agent_message"`).
---

# `agent-message` — Rich User-Facing Cell Messages

Emit a formatted user-facing message card from inside a running TypeScript cell while keeping intermediate logs inside the cell stream.

## Import

```ts
import { agent_message, AgentMessageError } from "agent_message";
```

## Usage

```ts
agent_message("## Deployment Ready\nAll 42 integration tests passed.", {
  title: "Verification Complete",
});
```
