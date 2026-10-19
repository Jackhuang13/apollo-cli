---
name: agent-message
description: Send a message to a reachable agent (parent, sibling, or child) from a kernel cell via `agent_message.send(...)`.
---

# `agent-message` — Session-to-Session Messaging

Send a message from the kernel to one reachable agent. Routing, sender identity,
and delivery all live in the host; the kernel client only picks the recipient
and returns the delivery receipt.

## API

```ts
const receipt = await agent_message.send(message, {
  receiver_role: "parent", // "parent" | "sibling" | "child"; omit to broadcast
  receiver_name: "worker", // required for sibling/child, omit for parent
});
```

- `receiver_role: "parent"` — message goes to the agent that owns this session; `receiver_name` must be omitted.
- `receiver_role: "sibling" | "child"` — `receiver_name` is required (the sibling/child's name).
- Omit `receiver_role` to broadcast to the whole family; the receipt is `{ receipts: [...] }` with one entry per recipient.
- The receipt carries `{ id, message, deliveryStatus, target: { activeSessionId, sessionId, sessionName? } }`.
- Discover reachable agents with `await agent_observe.list_agents()`.

A delivery card is emitted automatically from the receipt, so the UI shows the
send without printing the receipt yourself.

## Display-only card (no send)

```ts
agent_message.display("## Deployment Ready\nAll 42 integration tests passed.", {
  title: "Verification Complete",
});
```
