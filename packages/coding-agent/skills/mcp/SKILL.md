---
name: mcp
description: Use external MCP services generically from TypeScript - search the supported-service catalog, inspect the user's connections, discover live tool schemas, and call tools on any connection (Notion, Linear, Slack, and the rest of the catalog) without per-service packages.
---

# MCP Services

Every external service reachable over MCP uses the pre-loaded `mcp` helper in the TypeScript REPL.

## Inventory: what can I use?

```ts
// Supported catalog, one bounded page. More pages exist while nextCursor is not null.
const page = await mcp.list_plugins("not_connected", 50);
const results = await mcp.search_plugins("notion");
const firstPage = await mcp.list_plugins();

// The user's actual connections. connectionId is the dispatch id everywhere below.
const connections = await mcp.list_connections();
```

Catalog entries carry `connectionStatus` (`connected`, `pending`, `not_connected`, `setup_required`, `disabled`, `error`), `connectable`, and when connected the `connectionIds` you dispatch on.

## Discover, then call

```ts
// Live tool metadata is cached per connection; schemas come from the server.
const tools = await mcp.search_tools("search workspace documents", "notion");
const tool = await mcp.describe_tool("notion", "notion-search"); // { name, description, inputSchema }
const allTools = await mcp.list_tools("notion");

const result = await mcp.call_tool("notion", "notion-search", { query: "roadmap" });
```

- Discover before calling: read `inputSchema` with `describe_tool` and construct matching arguments.
- Results are already parsed JavaScript objects or strings.
