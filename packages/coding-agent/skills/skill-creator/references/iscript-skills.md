# TypeScript-Backed Skills

A TypeScript-backed skill is a regular markdown skill that also ships a TypeScript module for the IScript kernel. Apollo CLI pre-imports the module at kernel startup and binds it to its import name, so the agent can call it directly instead of shelling out.

## Detection Contract

All of these must hold or the skill silently degrades to a markdown-only skill (with a load warning):

- `SKILL.md` exists as usual.
- A `deno.json` exists at the skill root — its presence is what marks the skill as TypeScript-backed (a legacy `pyproject.toml` is still recognized as the marker).
- The import name is the skill name with hyphens converted to underscores, and it must be a valid identifier.
- An entrypoint resolves: `src/<import_name>/mod.ts`, falling back to `src/<skill_name>/mod.ts`, then `src/mod.ts`.

For a skill named `word-count`, the kernel exposes `word_count`. The default export is callable and named exports are auto-promoted to globals.

## Minimal Template

```
word-count/
├── SKILL.md
├── deno.json
└── src/
    ├── mod.ts
    └── word_count/
        └── mod.ts
```

**`SKILL.md`**

```markdown
---
name: word-count
description: Count word frequencies in text and return the most common words. Use when the user asks for word counts or frequency analysis of a text snippet.
---

# Word Count

Call directly from the kernel:

    await word_count("some text to analyze", { top: 3 })

Or from a shell cell:

!word-count "some text to analyze" --top 3
```

**`deno.json`**

```json
{
  "name": "@apollo/skill-word-count",
  "version": "0.1.0",
  "exports": "./src/word_count/mod.ts"
}
```

**`src/mod.ts`**

```ts
export * from "./word_count/mod.ts";
export { default } from "./word_count/mod.ts";
```

**`src/word_count/mod.ts`**

```ts
export interface CountOptions {
  top?: number;
}

export async function word_count(text: string, options: CountOptions = {}): Promise<string> {
  // Count words in text and return the most common ones.
  const top = options.top ?? 5;
  const counts = new Map<string, number>();
  for (const word of text.toLowerCase().split(/\s+/)) {
    if (!word) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([word, count]) => `${word}: ${count}`)
    .join("\n");
}

export const run = word_count;
export default word_count;
```

## Scaffolding from the REPL

The built-in `skill-creator` skill can generate the layout for you:

```ts
import { scaffold_skill } from "skill_creator";

scaffold_skill({
  name: "word-count",
  description: "Count word frequencies in text and return the most common words.",
  dir: ".apollo/agent/skills",
  withModule: true,
});
```

This writes `SKILL.md`, `deno.json` (`{ name: "@apollo/skill-<name>", version: "0.1.0", exports: "./src/<import_name>/mod.ts" }`), `src/<import_name>/mod.ts` with a placeholder export, and `src/mod.ts` re-exporting it.

## The run() Convention

If the module exports `run()` (or a default callable), the runtime's `rlm/skill` module can execute it as a shell command:

```ts
await word_count("text")        // from the kernel
word_count.run("text")          // same function via the named export
```

- `run()` may be sync or async; the helper awaits awaitable results.
- The helper parses CLI arguments into positional and `--option value` pairs (with primitive coercion), calls `run(...positional, named)`, and prints non-null results (objects as JSON).
- Without `run()`, the module is still imported and exposed by name, just not callable as a command.
- Import failures do not break the kernel: the name is bound to a placeholder that throws when called, carrying the import error in its `__apollo_skill_unavailable__` property.

## Optional CLI Command

A skill is available as a shell command under its name; run `<skill> --help` to discover usage. The backing helper imports the module, calls its `run()` export (or default callable), and handles argument parsing as above. Omit `run()` when a CLI is not needed.

The agent can then use either form:

```ts
await word_count("apollo cli", { top: 3 })
```

```bash
!word-count "apollo cli" --top 3
```

## Dependencies

The kernel provides Node.js builtins and a set of pre-installed packages (yaml, zod, undici/http, dotenv, toml, xml, math, pandas), so depending on them is free. There is no per-skill virtualenv: vendor third-party code into the skill directory or rely on what the kernel ships.

A TypeScript skill runs inside the agent's kernel, so it can itself spawn recursive sub-agents with `await rlm.spawn("subtask", "worker")` — useful for skills that delegate open-ended work.

## Verifying a TypeScript Skill

1. Check the contract: skill name maps to a valid identifier, `deno.json` exists at the skill root, and an entrypoint resolves (`src/<import_name>/mod.ts` or `src/mod.ts`).
2. Test the module standalone from the skill directory, without the kernel (run it directly with Deno or tsx).
3. In a fresh agent session (the kernel imports skills at startup), confirm `await <import_name>(...)` works. If it throws, the error contains the underlying import error.
