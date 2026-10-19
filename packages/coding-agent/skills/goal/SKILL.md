---
name: goal
description: Autonomous goal-tracking workflow for decomposing objectives, defining measurable verification criteria, and iterating until all acceptance criteria pass. Import via `import { create_goal } from "goal"`.
---

# `goal` — Autonomous Goal Verification

Decompose multi-step objectives into explicit acceptance criteria and verify each criterion with concrete evidence before concluding.

## Import

```ts
import { create_goal } from "goal";
```

## Usage

```ts
const tracker = create_goal({
  goal: "Migrate authentication middleware to JWT v2",
  criteria: [
    "Token verifier accepts RS256 and rejects HS256",
    "Integration test suite passes",
  ],
});

tracker.verify(
  "Token verifier accepts RS256 and rejects HS256",
  true,
  "test/auth.test.ts passed",
);
console.log(tracker.status());
```
