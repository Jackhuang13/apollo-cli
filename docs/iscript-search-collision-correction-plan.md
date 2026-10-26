# IScript search bare-global collision — correction plan

Status: implemented and verified (fresh-kernel probe + full check suite, see §6 results). Scope: targeted deconfliction of the one observed
name collision. Related: `iscript-repl-open-questions.md` (OQ-04),
`iscript-repl-improvement-plan.md` (IMP-03).

## 1. Problem

The bare global `search` in the IScript kernel is bound to the **refine skill's
harness search** (`refine.search(query, kind, limit, options)` ->
`harness.search`), shadowing the **websearch skill's** same-named export
(`websearch.search` -> Exa `web_search_exa`).

Verified live (session 01a173b8):

- `search('apollo-cli IScript kernel', { num_results: 2 })` ->
  `unknown harness kind {"num_results":2}; expected one of ["prompt","memory","skill","subagent"]`
  — a misleading error that reveals nothing about the collision.
- Introspection: `search`'s body is `return _getHarness().search(query, kind, limit, options)`
  (refine skill, `packages/coding-agent/skills/refine/src/refine/mod.ts`).
- Bare `websearch` global = default-export object
  `{ search, code_context, codeContext, WebSearchError }` — that name is not contested.
- Explicit import works: `import { search as webSearch } from "websearch"` routes to Exa and
  fails cleanly with `MCP server 'exa' is not declared in user settings` (a config gap, not a
  broken path).

Impact: a bare `search(...)` call, or one cell importing websearch's `search` followed by
refine usage in another, silently resolves to the wrong service; the failure surfaces only as a
harness kind-validation error.

## 2. Root cause

Three TS-migration changes compounding. The pre-migration Python kernel
(`.craft/prime-agent/`) did not have this problem:

| factor | old kernel (Python) | new kernel (IScript/TS) |
|---|---|---|
| websearch API | exports only `run` (Serper) | exports `search`, `code_context` (Exa) |
| refine API | exports only `run`, `status` | full harness CRUD surface incl. `search` |
| bootstrap binding | `globals()[skill_name] = wrap_skill_module(...)` — one global per skill, named after the skill | `buildIScriptBootstrapCode` (`iscript.ts:120-125`) flattens every skill's named exports onto `globalThis` via `if (!(key in globalThis))` (first-loaded skill wins -> `refine.search` claims `globalThis.search`, silently dropping `websearch.search`) |
| cell import binding | standard Python module scope | `_transformTopLevelImports` (`repl.ts:822-830`) promotes imported names onto `globalThis` and `_userGlobals` (last import wins, permanently overwriting bare `globalThis.search`) |

No old-kernel skill exported a `search` symbol, and the old bootstrap never promoted named
exports to globals. The collision is a migration regression, not a pre-existing design.

## 3. Chosen fix

1. Rename the websearch skill's named export `search` -> `web_search` (plus a camelCase alias
   `webSearch`, matching the existing `codeContext` convention), and update the validation error
   message in `web_search` from `"search(query)..."` to `"web_search(query)..."`.
2. Wrap the default export `websearch` with `Object.assign(web_search, { web_search, webSearch, code_context, codeContext, WebSearchError })` (matching the `compact` skill pattern) so both `await websearch("...")` (callable skill global promised by the system prompt) and `await websearch.web_search("...")` / `await web_search("...")` work seamlessly.

Rationale:

- Demote websearch, not refine: refine's `search` is the canonical harness search with broader
  consumers (harness digest / auto-refine workflow); websearch has a single consumer (Exa).
- Restores the old-kernel property that bare `search` is never websearch, while making bare
  `await websearch("...")` directly callable as documented.
- Old usage (`import { search } from "websearch"`, the `import { search as webSearch }`
  workaround) fails with a clear import error — self-correcting. No backward-compat alias, per
  repo policy.
- `code_context` / `codeContext` are unchanged (no collision).

Non-goals (tracked elsewhere):

- Bootstrap named-export flattening and import-rewriter promotion semantics remain — the
  structural OQ-04/IMP-03 gap. Other generic verbs across skills (`run`, `status`, `list`,
  `create`, `update`) and future user skills could still collide; this plan only deconflicts
  `search` / `websearch`.
- Exa credential/connection gap (user config, not code).

## 4. Changes

| # | file | change |
|---|---|---|
| 1 | `packages/coding-agent/skills/websearch/src/websearch/mod.ts` | rename export `search` -> `web_search` (and its empty-query error string); add `export const webSearch = web_search`; wrap default export with `Object.assign(web_search, { web_search, webSearch, code_context, codeContext, WebSearchError })` |
| 2 | `packages/coding-agent/skills/websearch/SKILL.md` | update import examples (`import { web_search, code_context } from "websearch"`); update frontmatter `description` (it feeds the system-prompt skill list) |
| 3 | `packages/coding-agent/test/websearch-skill.test.ts` | update import + `web_search()` test in-place (respecting the test-policy net line budget: test line delta must not exceed source line delta) |
| 4 | `packages/coding-agent/.changes/<slug>.md` | changelog fragment: renamed websearch `search` -> `web_search` to resolve the bare-global collision with the refine/harness `search` |
| 5 | `packages/coding-agent/docs/skills.md` & `packages/coding-agent/README.md` | update the stale Serper-era websearch sections (`docs/skills.md:53-82`, `README.md:337`) to reflect the Exa-backed TS `websearch` (`web_search` / `code_context` and callable `websearch`) |

No changes: `skills/websearch/src/mod.ts` shim (`export *` follows automatically), bootstrap
binding code in `iscript.ts`, the `mcp.call_tool("exa", ...)` direct path, the other four test
files that mention websearch (they assert the skill name only), `apollo-cli-runtime`, and the
refine/harness skills.

## 5. Behavioral flip (existing sessions)

Sessions whose kernel previously ran `import { search } from "websearch"` have bare `search`
permanently rebound to websearch's (and recorded in `_userGlobals`) for that kernel's lifetime.
After a kernel restart with the fix, bare `search` reverts to refine's. Probability of
user-visible breakage: low — the recorded workaround used an alias (`webSearch`) that does not
mutate the bare global, and no documented path relies on bare `search` being websearch.

## 6. Verification

1. From `packages/coding-agent`:
   `npx tsx ../../node_modules/vitest/dist/cli.js --run test/websearch-skill.test.ts`
2. `npm run check` and `npm run check:test-policy` (full output; fix anything reported).
3. Fresh-kernel live probe:
   - bare `search` still resolves to refine/harness (kind-validation behavior unchanged);
   - bare `web_search` (auto-promoted at bootstrap) and `import { web_search } from "websearch"`
     then `await web_search("...", { num_results: 1 })` -> clean
     `MCP server 'exa' is not declared in user settings` (path sound, blocked only on config);
   - `await websearch("...")` and `await websearch.web_search("...")` via the bare default-export
     callable object route to Exa as well;
   - `import { search } from "websearch"` -> clear import error naming the missing export.
4. Update the local harness memory `iscript-search-collision-and-mcp-status` (workaround ->
   `web_search`). (Done in session 01a17616 as a fresh local memory
   `iscript-websearch-renamed-to-web_search`; the 01a173b8 local entry is
   session-scoped and not reachable from later sessions.)

## 6a. Implementation & verification notes (session 01a17616)

- One change beyond the plan table: the static import rewriter
  (`apollo-cli-runtime/src/rlm/repl.ts`, `_namedExportCheck`) now fails
  `import { name }` cells with a clear error listing the module's available
  named exports when the named export is missing, instead of silently binding
  `undefined` and clobbering a same-named bare global. Regression test:
  `apollo-cli-runtime/test/repl.test.ts` ("missing-export"). Promotion
  semantics for existing exports are unchanged (OQ-04/IMP-03 remain open).
- Verification results, all passing:
  1. `packages/coding-agent`: `test/websearch-skill.test.ts` 2/2 pass.
  2. `apollo-cli-runtime`: `test/repl.test.ts` 17/17 pass (native node:test
     runner, not vitest).
  3. `npm run check` clean (biome 923 files, no fixes; tsgo x2;
     check:test-policy; installer; push-guard 31 cases; browser-smoke).
  4. Fresh-kernel live probe: bare `search` still refine/harness
     (kind-validation error unchanged); `web_search` / `websearch()` /
     `websearch.web_search` all reach Exa and fail only on the missing
     user-config `exa` MCP server; `import { search } from "websearch"`
     fails with a clear missing-export error and does not clobber the bare
     `search` global.

## 7. Follow-ups (not in this plan)

- IMP-03: audit bootstrap named-export flattening (`iscript.ts:120-125`) and cell import global
  promotion (`repl.ts:822-830`) across all skills sharing generic verb exports (`run` in
  `compact`/`refine`, `status` in `compact`/`refine`, `list` in
  `refine`/`rlm-heartbeat`/`orchestration-heartbeat`, `create` in
  `goal`/`rlm-heartbeat`/`orchestration-heartbeat`, `update` in
  `rlm-heartbeat`/`orchestration-heartbeat`); add collision detection + hint and explicit-import-wins semantics (structural fix for OQ-04).
- Broader `docs/skills.md` and `README.md` Python-era framing cleanup beyond the `websearch`
  passages covered in item 5 above.
