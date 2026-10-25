# IScript Kernel

Apollo CLI replaced the model-facing Python (IPython) REPL with **IScript**, a TypeScript REPL
runtime that executes on Node (`--experimental-strip-types`) or Deno. This page describes how the
kernel works today and lists the known integration gaps to work through before adjusting IScript.

> **Naming.** "IScript" is a repo-internal name, not an external npm/Deno package (verified
> against npm registry and web search on 2026-10-19).

## Current state in one paragraph

The kernel remains a **single JSON-lines-over-stdio subprocess** driven by
`ReplKernelManager` (protocol v3, `src/core/kernel/repl-manager.ts`). The model-facing tool is now
`iscript` (the default active tool); `ipython` is registered as an alias of the same
implementation, so both names run in the same one kernel. Which runtime process is spawned is
decided at spawn time: `apollo-cli-runtime/src/rlm/mod.ts` is mandatory and required for execution.
If configured to use Deno (e.g. `APOLLO_KERNEL_DENO`), it runs via `deno run -A --unstable-kv --unstable-node-globals`;
otherwise it executes on Node (`node --experimental-strip-types`). The legacy Python runtime has
been completely retired.

## Tool naming

| Path | Status |
|---|---|
| `src/core/tools/iscript.ts` | The single implementation (`IScriptKernelProvisioner`, `createIScriptToolDefinition`). Tool label dynamically indicates `iscript (Node VM)` or `iscript (Deno)`. |
| `src/core/tools/ipython.ts` | 30-byte re-export shim (`export * from "./iscript.js"`). |
| `src/core/tools/index.ts` | `createAllToolDefinitions` registers **both** `iscript` and `ipython`, sharing one provisioner and one kernel. |
| `src/core/agent-session.ts` | Default active tools: `["iscript"]`. An active goal force-adds `iscript`. |

The interactive UI cell is `IScriptCellComponent` (`src/modes/interactive/components/iscript-cell.ts`);
`ipython-cell.ts` is a 1-line alias shim.

## Execution path (host side)

Flow: model calls `iscript`/`ipython` → `IScriptKernelProvisioner.ensure()` (memoized) →
`startKernel()` (`iscript.ts`) → `ReplKernelManager.doStart()` (`repl-manager.ts`):

1. Runtime discovery: `apollo-cli-runtime/src/rlm/mod.ts` resolved from `process.cwd()`, `../`,
   `../../`, package directories, and `options.cwd`. If not found, startup fails with an actionable error.
2. Binary dispatch:
   - if `configured` binary ends in `deno` → `deno run -A --unstable-kv --unstable-node-globals <mod.ts>`
   - if custom interpreter override specified → `<custom-interpreter> <mod.ts>`
   - otherwise the host's own Node binary → `node --experimental-strip-types <mod.ts>`
3. Handshake: first stdout frame must be `{"event":"ready","protocol":3,"runtime":"node"|"deno",...}`.
   stderr is mirrored to a rotating `kernel-stderr.log` in the session artifact dir.

Startup order inside `startKernel()`: restore snapshot (if on disk) **before** executing the
bootstrap cell; the bootstrap cell binds `rlm`, `bash`, preloaded skills, and `NO_COLOR=1`, and a
bootstrap failure aborts kernel startup.

## What the IScript kernel runs

`apollo-cli-runtime/` (root-level directory, **not** an npm workspace member — it runs from raw
source and is not type-checked by workspace tooling):

- **Entry**: `src/rlm/mod.ts` → `startReplLoop()` (`src/rlm/repl.ts`).
- **Execution model**: cells run via `node:vm` `runInThisContext()` in the process's own context
  with a shared `globalThis`, so variables persist across cells. Top-level `await` is supported.
- **Cell transform pipeline**: leading `!cmd` lines become `await bash("cmd")`; TypeScript types
  are stripped with `node:module` `stripTypeScriptTypes`; top-level `import` statements are
  rewritten to `await __apollo_import__(...)` with declared names promoted to `globalThis`; a
  custom statement splitter handles the rest; the last bare expression is returned as the
  `result` event. `bash()` results bind to `_`.
- **rlm namespace** (preloaded globals): `rlm.spawn`, `rlm.create_session`, `rlm.find_models`,
  `rlm.list_subagents`, `rlm.collect`, `rlm.progress_note`, `rlm.delete_subagent`, `rlm.view`,
  plus `bash`, `mcp`, `harness`, `get_harness_state`, `host_request`, `emit`. Accessing
  `rlm.run` throws a rename error (matches the host readiness check).
- **Liveness**: 1s parent-pid watchdog (host dies → kernel shuts down), SIGTERM/SIGHUP kill live
  bash handles and exit, SIGINT interrupts the active cell only.
- **Skill loading** (`__apollo_import__`): skill roots are `$APOLLO_SKILLS_DIR` (the
  host defaults it to `<agent dir>/skills`, i.e. `~/.apollo/agent/skills`, when unset)
  and `<cwd>/packages/coding-agent/skills`; per-skill candidates `src/<name>/mod.ts`
  etc.; falls back to `createRequire(...).require(spec)` and then a dynamic `import()`.

## Kernel protocol (v3, shared by both runtimes)

The canonical wire contract is documented in `prime-agent-runtime/src/rlm/repl.md` and implemented
by both runtimes.

- **Requests** (stdin, one JSON object per line): `execute {id, code}`, `interrupt`,
  `host_reply {id, data}`, `snapshot {id, path, manifest_path, ...}`, `restore {id, path}`,
  `list_names {id}`, `shutdown`.
- **Events** (stdout): `ready`, `stdout`/`stderr`, `result`, `display {id, data:{mime:payload}}`,
  `host_request {id, data}`, `error`, `done {id, status}`.
  - **Ready event handshake**:
    - `event: "ready"`
    - `protocol: 3`
    - `runtime: "node" | "deno"` (explicit execution engine indicator)
    - `node: string` (Node.js engine version)
    - `deno?: string` (Deno version, present only when running under real Deno)
    - *Note*: The misleading legacy `python` and fake `deno` fields (which previously echoed Node's version) have been completely removed.
- **Host request dispatch**: the host reads `event.data`, requires `data.type` to be a string,
  dispatches to the registered handler, and replies
  `{type:"host_reply", id:<same id>, data:{status:"ok", result} | {status:"error", error}}`.
- **Host handler keys** (registered per session in `agent-session.ts`): `rlm.run`,
  `rlm.create_session`, `rlm.find_models`, `rlm.list_subagents`, `rlm.collect`,
  `rlm.delete_subagent`, `rlm.progress.note`, `bash.completed`, `bash.consumed`, `model.info`,
  `goal.get|create|complete`, `compact.run|status`, `refine.run|status`, `rlm_heartbeat.*`,
  `agent_message.*`, `mcp.refresh|config|list_plugins|search_plugins|list_connections`.
  (MCP tool I/O — `list_tools`/`call_tool` — runs **inside** the kernel, not through host
  requests, in both runtimes.)
- **Display MIME contracts**: `application/vnd.apollo-cli.{diff,attachment,agent-message,bash-activity}+json`
  with `application/vnd.prime-agent.*` legacy aliases (`src/core/kernel/shared.ts`). Unknown
  display MIMEs are silently dropped by the host.
- Execution is strictly serial; after a successful `execute` the host schedules a debounced
  (1.5s) auto-snapshot. Unknown event kinds trigger protocol repair (kill, restart, restore,
  re-bootstrap).

## State snapshot and restore

- Host side is runtime-agnostic: debounced auto-snapshot after each ok `execute`; `restoreState()`
  runs before the bootstrap cell at kernel start; files are `kernel-state.snap` (preferred) /
  `kernel-state.dill` (legacy fallback) plus a `kernel-state.json` manifest in the session
  artifact dir (`state-snapshot.ts`).
- **IScript serializer**: each tracked user global is `v8.serialize`d; layout is
  `APOLLO-CLI-KERNEL-SNAPSHOT-V1` magic + `[u32 nameLen][name][u64 payloadLen][v8 payload]`
  frames; per-variable 16MiB cap (`DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES`), 256MiB total (`DEFAULT_SNAPSHOT_MAX_BYTES`).
  - **Unserializable types**: functions (`function`), symbols (`symbol`), promises, weak references (`WeakMap`/`WeakSet`), and live handles/sockets/streams cannot be restored and are skipped at snapshot time with reason `unserializable_type`.
  - **Class prototypes**: restored objects whose prototypes were user-defined classes lose prototype methods and degrade to plain objects (`prototype_lost`).
  - **Compaction & Tombstones**: compaction prunes variables exceeding the per-variable 16MiB cap. Pruned variables receive an active tombstone in `globalThis` that raises a descriptive `ReferenceError` on access naming the size and reason, and can be cleanly restored or overwritten with new values.
  - **Restore diagnostics**: `restoreState()` reconciles both the binary payload and the `kernel-state.json` manifest (`skipped` and `pruned` lists), notifying the host and model about all omitted or caveat-laden variables via `[python-state-restored]`.
- **Cross-runtime snapshots are not interoperable**: a Python-era `.dill` file will not parse in
  the IScript runtime and vice versa. A session that switches runtimes restores to an empty
  namespace (the on-disk file is preserved, not clobbered).
- New preloaded globals must be added to `_RESERVED_NAMES` in `apollo-cli-runtime/src/rlm/repl.ts`
  or they leak into snapshots. `list_names` excludes any name starting with `_`.

## Distribution reality

The build pipeline (`coding-agent` `copy-assets`, `scripts/copy-binary-assets.mjs`) packages
`apollo-cli-runtime/` with the package, and a binary build is rejected when
`apollo-cli-runtime/src/rlm/mod.ts` is missing. **Installed npm/binary releases therefore run
the IScript TS runtime**; a source checkout resolves the same `mod.ts` via the cwd- and
package-relative discovery in `repl-manager.ts`. The legacy Python kernel has been retired.

## Known integration gaps (read before adjusting IScript)

### P0-1: the IScript `host_request` bridge is wire-incompatible with the host

The Python runtime and the protocol doc agree on `{"event":"host_request","id":<rid>,"data":{...}}`,
replies paired on `id`, callers resolving the inner `data`. The IScript runtime deviates on five
axes (`apollo-cli-runtime/src/rlm/repl.ts`, `src/rlm/mod.ts`):

1. Frame: sends `{id: <cellId>, event:"host_request", request_id: <rid>, payload}` — the host
   reads `event.data` (absent) and pairs replies on `event.id` (the cell id). The host reply never
   matches the runtime's pending map, so calls hang until the 300s timeout.
2. Dispatch key: `mod.ts` sends `op: "rlm_spawn"` / `rlm_create_session` / ...; host handlers are
   keyed `rlm.run` / `rlm.create_session` / ...
3. Payload shape: `mod.ts` sends flat `{prompt, name, model, ...}`; the `rlm.run` handler expects
   `{prompt, kwargs:{...}}` and returns a handle record; callers check `reply.ok`/`reply.result`
   while the host replies `data.status`/`data.result`.
4. Reply unwrap: the runtime resolves the entire host_reply line instead of `msg.data`.
5. `rlm.progress_note` emits a display MIME (`application/vnd.apollo-cli.progress-note+json`) the
   host has no branch for, so progress notes are silently dropped (the Python path uses the
   `rlm.progress.note` host request, which the host does handle).

Concrete impact in the IScript kernel (the Python fallback kernel is unaffected):

- `rlm.spawn` / `create_session` / `find_models` / `list_subagents` / `collect` /
  `delete_subagent` → 300s hang, then timeout. **Subagent delegation is unusable.**
- `bash.completed` (background bash completion follow-up) → never accepted.
- MCP discovery/config via host (`mcp.config`, `mcp.refresh`, `mcp.list_*`) → 15s inventory
  timeout → generic MCP (and the `mcp` skill / websearch Exa path) fails.
- The TS `agent-message` skill has **no `send()`** (only a display-only emit);
  `await agent_message.send(...)` throws a TypeError. The TS `goal` skill lacks
  `get/create/complete`; `compact` and `rlm-heartbeat` skills use the wrong `op` names.

Evidence this is a bug and not an alternate contract: `bash.consumed` is sent via `sendRawEvent`
with the **correct** `data:` field (`apollo-cli-runtime/src/rlm/bash.ts`).

Minimal fix surface: make `repl.ts host_request()` send `{id: <rid>, event:"host_request",
data:{type, ...}}` and resolve `msg.data` (rejecting on `status==="error"`); rename `mod.ts` ops
to the host handler keys with `{prompt, kwargs}` payloads; make `progress_note` a
`rlm.progress.note` host request; add a TS `agent_message.send()` mirroring the Python one.

### P0-2: system prompt gating still keys off "ipython"

`src/core/prompts/rlm.ts` (`buildChildAgentDoctrine` and `buildRlmPrompt`) compute
`hasIpython = activeTools === undefined || activeTools.includes("ipython")`. With the new default
active tool `iscript`, this is `false`, so the system prompt **drops** the entire REPL control
prompt, the depth-0 `rlm.create_session` block, most of the delegation doctrine, and the
pre-imported skill list; child agents lose the `agent_message.send` reply instruction. The prompt
also still says "Pre-installed Python packages ... uv pip install", which describes the Python
venv, not the Node kernel.

### P1: ACP MCP injects Python code

`src/core/tools/acp-mcp.ts` injects Python snippets (`print(__import__("json").dumps(...))`) into
the kernel; under the IScript kernel this is a syntax/reference error, so ACP MCP is
IScript-broken. `src/core/goals.ts` still tells the model to call `goal.complete()` "in the
Python REPL".

### P1: bundled skills ship a partial TS surface

All 17 bundled skills carry a TS `src/**/mod.ts`; several are self-contained and plausibly
working (`edit`, `attach-image`, `mcp`), while the host-bridge users are broken or divergent
(`compact`, `rlm-heartbeat`, `agent-message`, `goal`, `websearch` — the TS websearch targets Exa
with a wrong `call_tool` argument order and ignores the injected `SERPER_API_KEY`). One runtime
behavior is unverified: whether Node `require()` can load the ESM-flavored `.ts` skill modules
under `--experimental-strip-types`, or whether the dynamic-import fallback carries the load.

### P2 and stale artifacts

- Snapshot: functions/classes are lost on resume (v8 limitation); `_RESERVED_NAMES` must be
  maintained by hand.
- Error/progress strings in `iscript.ts` have been aligned with the active IScript engine ("Starting IScript kernel...",
  "Failed to initialize rlm runtime in the IScript kernel", "Waiting for IScript kernel...").

## Test coverage summary

- **IScript kernel itself**: `test/ipython-bootstrap.test.ts` is the only test that actually
  spawns the IScript kernel (bootstrap globals + `NO_COLOR`).
- **Runtime-agnostic host logic**: `ipython-provisioner.test.ts` (fake python shim),
  `ipython-cell-preview.test.ts`, `kernel-agent-message-skill.test.ts`,
  `kernel-attach-image-skill.test.ts`, `rlm-*.test.ts` (no kernel).
- **Python-only integration**: the `repl-kernel-*` suite (execute, abort, shutdown, startup,
  pipe errors, protocol corruption, MCP shutdown, parent watchdog, state round-trip) — all
  skip when no Python venv is available. There is **no IScript equivalent** and no test pins the
  IScript↔host `host_request` wire format.

## Checklist for future IScript adjustments

1. Fix the `host_request` bridge (P0-1) — everything delegation/MCP/bash-followup-related hangs
   until this is done.
2. Add IScript integration tests mirroring `repl-kernel-execute` and
   `repl-kernel-state-roundtrip` (spawn node+mod.ts; execute/interrupt/snapshot/restore;
   `host_request` round-trip) so the wire format is pinned.
3. Decide the Python bootstrap's future: skip `ensureKernelPython` when the IScript runtime
   resolves (and fix `APOLLO_KERNEL_DENO`), or document the Python venv as a hard dependency.
4. Make prompt gating treat `iscript` and `ipython` as equivalent (`prompts/rlm.ts`) and replace
   the Python-venv package list in the prompt with an IScript-accurate one.
5. Port ACP MCP code injection to JS; fix the goal/goal-skill wording.
6. Audit the remaining skill TS surfaces against their Python counterparts.
