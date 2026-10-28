---
name: skill-creator
description: Create, validate, and install Apollo CLI skills - both markdown skills and Deno/TypeScript-backed skills callable from the IScript REPL. Use when the user asks to create a skill, turn a workflow or script into a reusable skill, or asks how to write a SKILL.md and deno.json.
---

# Skill Creator

A skill is a directory with a `SKILL.md` file (YAML frontmatter + markdown instructions) and an optional `deno.json` + `src/<skill_name>/mod.ts` TypeScript module.

| Kind | What it is | When to use |
|---|---|---|
| markdown | `SKILL.md` plus optional scripts, references, and assets | Workflows, CLI recipes, domain knowledge, multi-step instructions |
| typescript | A markdown skill that also ships a `deno.json` and `src/<name>/mod.ts` module | Capabilities callable directly from the TypeScript REPL (`import { my_skill } from "my_skill"`) |

## Layout

```
my-skill/
├── SKILL.md              # Required: frontmatter + instructions
├── deno.json             # Optional: Deno/TS package manifest
└── src/
    ├── mod.ts            # Re-exports ./my_skill/mod.ts
    └── my_skill/
        └── mod.ts        # Exported TypeScript functions
```

## Scaffolding from the REPL

```ts
import { scaffold_skill } from "skill_creator";

scaffold_skill({
  name: "my-skill",
  description: "Perform custom validation checks when reviewing PRs.",
  dir: ".apollo/agent/skills",
  withModule: true,
});
```
