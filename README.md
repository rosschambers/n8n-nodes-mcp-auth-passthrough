# n8n-nodes-mcp-auth-passthrough

An [n8n](https://n8n.io) community node package that adds an **MCP Client Tool (Auth
Passthrough)** node: a variant of the stock MCP Client Tool node whose bearer token is
resolved from a per-item expression at execution time, instead of a static credential.

## Why

The stock MCP Client Tool node authenticates using a fixed credential chosen at design
time. That works for a single shared token, but breaks down when an AI agent needs to
call an MCP server on behalf of different users or requests, each carrying its own
token (for example a token forwarded from an incoming webhook, or looked up per item
from a database). This node lets you supply that token as an **expression**, so it is
resolved fresh for every item the node processes.

## Status

This package currently ships the MCP connection scaffold (endpoint configuration,
transport selection, tool listing) with `none` and `bearerAuth` (static credential)
authentication modes implemented. The `authPassthrough` mode — where the header value
is resolved from a per-item expression such as:

```
Bearer {{ $json.token }}
```

— is being added next. See `nodes/McpClientToolAuthPassthrough/shared.ts` for the
exact spot marked `TASK 2` where the new authentication case and its token parameter
will be implemented.

## Node

**MCP Client Tool (Auth Passthrough)** (`mcpClientToolAuthPassthrough`)

- **Endpoint URL** — the MCP server's URL. Supports expressions.
- **Server Transport** — `httpStreamable` (implemented) or `sse` (reserved).
- **Authentication** — `None`, `Bearer Auth` (uses n8n's built-in HTTP Bearer Auth
  credential), and soon `Auth Passthrough (Expression)`.
- **Options → Timeout** — request timeout in milliseconds.

The node connects to the configured MCP server, lists its available tools, and
exposes them on the node's `AI Tool` output for use by an AI agent.

## Installation

Install like any other n8n community node:

```bash
npm install n8n-nodes-mcp-auth-passthrough
```

Then follow n8n's [community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/)
to register the package with your n8n instance.

## Development

```bash
npm install
npm run build   # compiles nodes/ to dist/
npm test        # runs the test suite
```

## License

MIT — see [LICENSE](./LICENSE).
