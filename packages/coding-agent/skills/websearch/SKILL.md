---
name: websearch
description: Search the web and fetch technical documentation or code examples via Exa MCP (`import { search, code_context } from "websearch"` or `mcp.call_tool("web_search_exa", ...)`).
---

# `websearch` — Web & Code Context Search

Search the live web and retrieve library/SDK code context via the Exa MCP integration.

## Import

```ts
import { search, code_context } from "websearch";
```

## Web Search

```ts
const results = await search("Deno 2.x workspace configuration", {
  num_results: 5,
  type: "auto",
  livecrawl: "fallback",
});
console.log(results);
```

## Code & Documentation Context

```ts
const docs = await code_context("TypeScript AsyncLocalStorage context propagation examples", {
  tokens_num: 5000,
});
console.log(docs);
```

## Direct MCP Calls

You can also invoke Exa tools directly on the global `mcp` helper:

```ts
await mcp.call_tool("web_search_exa", { query: "latest release notes", numResults: 8 }, "exa");
await mcp.call_tool("get_code_context_exa", { query: "vitest fake timers", tokensNum: 5000 }, "exa");
```
