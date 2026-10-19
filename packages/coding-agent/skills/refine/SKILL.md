---
name: refine
description: Self-evolving harness workflow for inspecting and updating durable rules, skills, preferences, and workflow prompts via `harness` or `import { refine } from "refine"`.
---

# `refine` — Self-Evolving Harness Workflow

Evolve durable rules, skills, preferences, and workflow prompts based on concrete session evidence.

## Quick Access in the TypeScript REPL

`harness` is pre-loaded in the REPL global scope (or import `refine` via `import { refine } from "refine"`):

```ts
// 1. Inspect existing harness state
harness.overview();
harness.search("verification");

// 2. Create or update a durable rule or skill
harness.upsert_rule(
  "test-before-commit",
  "Always run the targeted test file before committing changes.",
  "Enforce targeted test verification",
  "project",
);

// 3. Record the refinement audit event
harness.record_refinement(
  "Missed running targeted test before reporting completion",
  ["rule:project:test-before-commit"],
  "project",
  "Cell 4 required a follow-up fix",
);
```

## Available Methods on `harness` / `refine`

- `overview()` / `snapshot()` / `search(query, limit?)`
- `list_rules(scope?)` / `get_rule(name, scope?)` / `upsert_rule(name, content, description?, scope?)` / `delete_rule(name, scope?)`
- `list_skills(scope?)` / `get_skill(name, scope?)` / `upsert_skill(name, content, description?, scope?)` / `delete_skill(name, scope?)`
- `get_preferences(scope?)` / `update_preferences(patch, scope?)`
- `get_workflow_prompts(scope?)` / `update_workflow_prompt(key, value, scope?)`
- `record_refinement(reason, changes, scope?, evidence?)`
