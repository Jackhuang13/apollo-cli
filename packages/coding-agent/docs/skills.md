> Apollo CLI can create skills. Ask it to build one for your use case.

# Skills

Skills are self-contained capability packages that Apollo CLI loads on demand. A skill provides specialized workflows, setup instructions, helper scripts, and reference documentation for specific tasks.

Apollo CLI implements the [Agent Skills standard](https://agentskills.io/specification), warning about violations but remaining lenient. It also supports TypeScript-backed skills: a superset of markdown skills that ship an IScript module the persistent kernel imports and exposes to the model.

## Table of Contents

- [Locations](#locations)
- [Built-in Skills](#built-in-skills)
- [How Skills Work](#how-skills-work)
- [TypeScript-Backed Skills](#typescript-backed-skills)
- [Creating Skills with Apollo CLI](#creating-skills-with-apollo-cli)
- [Skill Commands](#skill-commands)
- [Skill Structure](#skill-structure)
- [Frontmatter](#frontmatter)
- [Validation](#validation)
- [Example](#example)
- [Skill Repositories](#skill-repositories)

## Locations

> **Security:** Skills can instruct the model to perform any action and may include executable code the model invokes. Review skill content before use.

Apollo CLI loads skills from:

- Global:
  - `~/.apollo/agent/skills/`
  - `~/.agents/skills/`
- Project:
  - `.apollo/agent/skills/`
  - `.agents/skills/` in `cwd` and ancestor directories (up to git repo root, or filesystem root when not in a repo)
- Packages: `skills/` directories or `pi.skills` entries in `package.json`
- Settings: `skills` array with files or directories
- CLI: `--skill <path>` (repeatable, additive even with `--no-skills`)
- Built-in: `skills/` shipped with the apollo-cli package (lowest precedence)

Discovery rules:
- In `~/.apollo/agent/skills/` and `.apollo/agent/skills/`, direct root `.md` files are discovered as individual skills
- In all skill locations, directories containing `SKILL.md` are discovered recursively
- In `~/.agents/skills/` and project `.agents/skills/`, root `.md` files are ignored

Disable discovery with `--no-skills` (explicit `--skill` paths still load).

## Built-in Skills

Apollo CLI ships with built-in skills that load by default:

- `prime-intellect` - Prime Intellect products and workflows via the prime CLI: verifiers environments and the Environments Hub, evaluations (local and hosted), Hosted Training and prime-rl, sandboxes, tunnels, Prime Inference, GPU compute, and storage. Reference docs for each area load on demand from the skill's `references/` directory.
- `skill-creator` - teaches the agent to create new skills: markdown skill layout, frontmatter rules, placement and precedence, and the full TypeScript-backed skill contract (module layout, `deno.json` metadata, detection rules, import-failure behavior) with a working template in `references/iscript-skills.md`.
- `websearch` - a TypeScript-backed web search and code-context skill via the [Exa](https://exa.ai) MCP integration.

Built-in skills behave like any other skill but have the lowest precedence: a user, project, package, or `--skill` skill with the same name overrides the built-in one.

### websearch

Setup: get an API key at [exa.ai](https://exa.ai) and declare an `exa` MCP
server under `mcpServers` in `settings.json` so the connection is available to the kernel:

```json
{
  "mcpServers": {
    "exa": {
      "type": "http",
      "url": "https://mcp.exa.ai/mcp",
      "headers": { "x-api-key": "<exa-api-key>" }
    }
  }
}
```

Once loaded, the model can call it directly in the TypeScript kernel — the
default export is callable, and the named exports are auto-promoted to globals:

```ts
console.log(await websearch("latest Apollo CLI release"));
import { web_search, code_context } from "websearch";
const results = await web_search("Deno 2.x workspaces", { num_results: 5 });
```

Until an `exa` server is declared, calls fail with a clear
"server not declared in user settings" error.

Disable only the built-in `websearch` skill in settings:

```json
{
  "bundledSkills": {
    "websearch": false
  }
}
```

To disable all built-in skills, set `enableBuiltinSkills` to `false` in `settings.json` (or toggle "Built-in skills" in `/settings`):

```json
{
  "enableBuiltinSkills": false
}
```

`--no-skills` also excludes built-in skills. To disable a single built-in skill without a dedicated setting, force-exclude it in the global `skills` array (patterns resolve against the built-in skills directory):

```json
{
  "skills": ["-prime-intellect/SKILL.md"]
}
```

### Using Skills from Other Harnesses

To use skills from Claude Code or OpenAI Codex, add their directories to settings:

```json
{
  "skills": [
    "~/.claude/skills",
    "~/.codex/skills"
  ]
}
```

For project-level Claude Code skills, add to `.apollo/agent/settings.json`:

```json
{
  "skills": ["../.claude/skills"]
}
```

## How Skills Work

1. At startup, Apollo CLI scans skill locations and extracts names, descriptions, type, and file locations
2. The system prompt includes visible skills in XML format per the [specification](https://agentskills.io/integrate-skills)
3. When a task matches, the agent uses `iscript` to load the full `SKILL.md` (models don't always do this; use prompting or `/skill:name` to force it)
4. The agent follows the instructions, using relative paths to reference scripts and assets

This is progressive disclosure: only descriptions are always in context, full instructions load on-demand.

Skills with `disable-model-invocation: true` are hidden from the startup skill list. They can still be invoked explicitly with `/skill:name`.

## TypeScript-Backed Skills

A TypeScript-backed skill uses the same `SKILL.md` metadata and invocation behavior as a markdown skill, but also ships a TypeScript module for the IScript kernel.

```
web-search/
├── SKILL.md
├── deno.json
└── src/
    ├── mod.ts
    └── web_search/
        └── mod.ts
```

Detection rules:
- `SKILL.md` is still required
- a `deno.json` at the skill root marks the skill as TypeScript-backed (a legacy `pyproject.toml` is still recognized)
- the import name is the skill name with hyphens converted to underscores; it must be a valid identifier
- the entrypoint is `src/<import_name>/mod.ts`, falling back to `src/mod.ts`

The kernel pre-imports every installed TypeScript-backed skill at startup: the default export is callable and named exports are auto-promoted to globals, so for `web-search` the model can write:

```ts
await web_search("apollo cli skills")
```

A skill whose entrypoint is missing or whose import fails degrades to its markdown instructions with a load warning; the bound name is a throwing placeholder tagged with the import error in its `__apollo_skill_unavailable__` property.

### Optional CLI Command

A TypeScript-backed skill is also available as a shell command under its name (run `<skill> --help` to discover usage). The runtime's `rlm/skill` module provides the `cli`/`runCli` helpers: they import the skill module, call its `run()` export (or default callable), parse CLI arguments into positional and `--option value` pairs, and print non-null results (objects as JSON):

```ts
export interface SearchOptions {
  limit?: number;
}

export async function run(query: string, options: SearchOptions = {}): Promise<string> {
  // search the web and return a concise summary
}
```

The model can then call the skill from the IScript REPL or from shell mode:

```ts
await web_search("apollo cli skills")
{ const __bang_res = await globalThis.bash("web-search "apollo cli skills" --limit 3"); if (__bang_res.output) { process.stdout.write(__bang_res.output); } globalThis._ = __bang_res; }
```

## Creating Skills with Apollo CLI

Apollo CLI ships with a built-in `skill-creator` skill that teaches the agent both the Agent Skills format and the TypeScript-backed package contract. You can ask for a skill in normal language:

```text
Create a project TypeScript-backed skill named release-audit in
.apollo/agent/skills/release-audit. It should expose
await release_audit(dir, { target_version }), include concise SKILL.md
instructions, declare its dependencies, and verify the module imports in a
fresh Apollo CLI session.
```

To force the creation workflow explicitly, invoke the built-in skill command:

```text
/skill:skill-creator Create a personal markdown skill for reviewing database migrations.
```

Tell the agent three things:

1. **Scope:** use `.apollo/agent/skills/<name>/` for a project skill committed with the repository, or `~/.apollo/agent/skills/<name>/` for a personal skill.
2. **Kind:** ask for a markdown skill when the capability is primarily instructions; ask for a TypeScript-backed skill when the agent should call reusable functionality from the IScript REPL.
3. **Contract:** describe the intended call, inputs, output, dependencies, credentials, and verification behavior.

The agent should create `SKILL.md` in both cases. For a TypeScript-backed skill it should also create `deno.json` and `src/<import_name>/mod.ts`, export a documented callable, and verify that the module imports in the kernel.

Use `/reload` to rediscover new or edited skill metadata. Start a fresh Apollo CLI session after adding a TypeScript-backed skill so kernel setup can import the module.

### Installed Skills and Continual Harness Skills

An installed TypeScript-backed skill is a real module on disk that adds executable functionality to the kernel. A continual harness skill entry is a persisted description of a reusable call, including its reference and argument contract. `/refine` can create or update the latter after a repeated procedure emerges, but it does not replace packaging new functionality with `skill-creator`.

## Skill Commands

Skills register as `/skill:name` commands:

```bash
/skill:brave-search           # Load and execute the skill
/skill:pdf-tools extract      # Load skill with arguments
```

Arguments after the command are appended to the skill content as `User: <args>`.

Toggle skill commands via `/settings` in interactive mode or in `settings.json`:

```json
{
  "enableSkillCommands": true
}
```

## Skill Structure

A skill is a directory with a `SKILL.md` file. Everything else is freeform.

```
my-skill/
├── SKILL.md              # Required: frontmatter + instructions
├── scripts/              # Helper scripts
│   └── process.sh
├── references/           # Detailed docs loaded on-demand
│   └── api-reference.md
└── assets/
    └── template.json
```

### SKILL.md Format

````markdown
---
name: my-skill
description: What this skill does and when to use it. Be specific.
---

# My Skill

## Setup

Run once before first use:
```bash
cd /path/to/skill && npm install
```

## Usage

```bash
./scripts/process.sh <input>
```
````

Use relative paths from the skill directory:

```markdown
See [the reference guide](references/REFERENCE.md) for details.
```

## Frontmatter

Per the [Agent Skills specification](https://agentskills.io/specification#frontmatter-required):

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Max 64 chars. Lowercase a-z, 0-9, hyphens. Must match parent directory. |
| `description` | Yes | Max 1024 chars. What the skill does and when to use it. |
| `license` | No | License name or reference to bundled file. |
| `compatibility` | No | Max 500 chars. Environment requirements. |
| `metadata` | No | Arbitrary key-value mapping. |
| `allowed-tools` | No | Space-delimited list of pre-approved tools (experimental). |
| `disable-model-invocation` | No | When `true`, skill is hidden from system prompt. Users must use `/skill:name`. |

### Name Rules

- 1-64 characters
- Lowercase letters, numbers, hyphens only
- No leading/trailing hyphens
- No consecutive hyphens
- Must match parent directory name

Valid: `pdf-processing`, `data-analysis`, `code-review`
Invalid: `PDF-Processing`, `-pdf`, `pdf--processing`

### Description Best Practices

The description determines when the agent loads the skill. Be specific.

Good:
```yaml
description: Extracts text and tables from PDF files, fills PDF forms, and merges multiple PDFs. Use when working with PDF documents.
```

Poor:
```yaml
description: Helps with PDFs.
```

## Validation

Apollo CLI validates skills against the Agent Skills standard. Most issues produce warnings but still load the skill:

- Name doesn't match parent directory
- Name exceeds 64 characters or contains invalid characters
- Name starts/ends with hyphen or has consecutive hyphens
- Description exceeds 1024 characters

Unknown frontmatter fields are ignored.

**Exception:** Skills with missing description are not loaded.

Name collisions (same name from different locations) warn and keep the first skill found.

## Example

```
brave-search/
├── SKILL.md
├── search.js
└── content.js
```

**SKILL.md:**
````markdown
---
name: brave-search
description: Web search and content extraction via Brave Search API. Use for searching documentation, facts, or any web content.
---

# Brave Search

## Setup

```bash
cd /path/to/brave-search && npm install
```

## Search

```bash
./search.js "query"              # Basic search
./search.js "query" --content    # Include page content
```

## Extract Page Content

```bash
./content.js https://example.com
```
````

## Skill Repositories

- [Anthropic Skills](https://github.com/anthropics/skills) - Document processing (docx, pdf, pptx, xlsx), web development
- [Pi Skills](https://github.com/badlogic/pi-skills) - Web search, browser automation, Google APIs, transcription
