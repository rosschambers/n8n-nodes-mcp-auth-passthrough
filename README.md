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

Implemented and working end to end: the node connects to an MCP server, lists its
tools, and exposes them to the AI Agent as LangChain tools. All three authentication
modes work — `none`, `bearerAuth` (static credential), and `authPassthrough`, where
the header value is resolved from a per-item expression such as:

```
{{ $json.token }}
```

resolved fresh for every item.

## Node

**MCP Client Tool (Auth Passthrough)** (`mcpClientToolAuthPassthrough`)

- **Endpoint URL** — the MCP server's URL. Supports expressions.
- **Server Transport** — `httpStreamable` or `sse` (both handled by the host MCP
  transport code — see Architecture).
- **Authentication** — `None`, `Bearer Auth` (uses n8n's built-in HTTP Bearer Auth
  credential), or `Auth Passthrough (Expression)`.
- **Options → Timeout** — request timeout in milliseconds.

The node connects to the configured MCP server, lists its available tools, and
exposes them on the node's `AI Tool` output for use by an AI agent.

## Architecture: it reuses the HOST n8n's MCP machinery (this is deliberate)

`supplyData` does NOT bundle or reimplement the MCP tool wrapping. At runtime it
loads the host n8n's own modules and calls them:

- `@n8n/n8n-nodes-langchain` → `connectMcpClient`, `getAllTools`,
  `mcpToolToDynamicTool`, `createCallTool` (the stock MCP Client Tool's helpers)
- `@n8n/ai-utilities` → `logWrapper`
- `n8n-core` → `StructuredToolkit`
- `@langchain/core` → `DynamicStructuredTool` (indirectly, via the helpers above)

The ONLY behavioural difference from the stock node is `getAuthHeaders` in
`shared.ts`, which adds the `authPassthrough` expression-token mode.

### Why reuse instead of reimplement — identity, and the `strict` crash

The AI Agent (ToolsAgent) binds each tool to the model with LangChain's
`convertToOpenAITool`:

```js
if (isLangChainTool(tool)) toolDef = { type: 'function', function: convertToOpenAIFunction(tool) };
else                       toolDef = tool;
if (fields?.strict !== undefined) toolDef.function.strict = fields.strict;
```

If our tool is not a recognised LangChain tool, `toolDef = tool` has no `.function`,
so `toolDef.function.strict = ...` throws **`Cannot set properties of undefined
(setting 'strict')`** — the error an earlier stub version of this node produced.
`isLangChainTool` is duck-typed (needs `name` + a zod-v3 `schema`), and the tool is
also invoked and unwrapped by the host. Separately, n8n-core's `getConnectedTools`
unwraps the response with `if (toolOrToolkit instanceof StructuredToolkit)` — an
`instanceof` check against the **host's** `n8n-core` class. Building the tools and the
toolkit with the host's OWN classes satisfies all of this exactly, on every n8n
release, with no shape drift.

### Runtime requirement: NODE_PATH must include the host node_modules

From a `N8N_CUSTOM_EXTENSIONS` (CUSTOM.*) node, bare specifiers like `n8n-core` or
`@langchain/core` do NOT resolve by default — the global n8n install
(`/usr/local/lib/node_modules/n8n/node_modules`) is not on the module search path.
The deploy adds it to `NODE_PATH` (see `serve-n8n/docker-compose.yml`). Resolution of
the stock helpers is upgrade-stable: the code resolves
`@n8n/n8n-nodes-langchain/package.json` (bare, no pnpm hash) and joins the internal
`dist/...` path as an absolute file path, bypassing the package `exports` map.

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
npm run build      # bundles nodes/ into a single self-contained dist/ CJS file (tsup)
npm run typecheck  # type-check only (tsc --noEmit); the build no longer type-checks
npm test           # runs the test suite
```

## Build: this package MUST be bundled — do NOT revert to plain `tsc`

The build (`npm run build`) uses **tsup** (esbuild) to compile the node into a
**single, self-contained CommonJS file** that ships with **no `node_modules`**. This
is deliberate and load-bearing. Do not "simplify" it back to `tsc` + a vendored
`node_modules`.

The node has essentially no bundled runtime dependencies: everything it needs at
runtime (the MCP SDK, LangChain, `n8n-core`, `@n8n/ai-utilities`) belongs to the
**host** n8n and is resolved from there (see Architecture above and the `external`
list in `tsup.config.ts`). So the bundle is tiny (~11 KB) and, critically, drops no
dependency files into the mounted directory.

### Why (the n8n custom-extension loader defect)

n8n loads packages pointed at by `N8N_CUSTOM_EXTENSIONS` with its
`CustomDirectoryLoader`, which does:

```js
fast_glob('**/*.node.js', { cwd: <extension dir>, absolute: true })
```

That is a **recursive glob with no `node_modules` exclusion**. For every file it
matches, n8n derives a class name from the filename (the part before the first
dot) and executes, inside a `vm` sandbox:

```js
new (require('<file>').<ClassName>)()
```

The Model Context Protocol SDK depends on `pkce-challenge`, whose Node build is
named `dist/index.node.js`. If our runtime dependencies live in a vendored
`node_modules` next to the mounted node, that file **matches `**/*.node.js`**.
n8n then treats it as one of our nodes: the class name becomes `index` (from
`index.node.js`), it `require()`s the file — on **Node 24 a CommonJS module CAN
`require()` an ES module**, and it succeeds, returning a namespace object with
`default`, `generateChallenge`, `verifyChallenge` and **no `index` export** — so
`new (namespace.index)()` is `new undefined()`, which throws:

```
evalmachine.<anonymous>:1
new (require('/opt/custom-nodes/.../pkce-challenge/dist/index.node.js').index)()
TypeError: require(...).index is not a constructor
```

There is **no `try/catch`** around this in the custom-extension code path, so the
exception is uncaught and **crash-loops the entire n8n process** (the container
restarts, hits the same file, crashes again).

Note what this is **not**: it is not a CommonJS-can't-require-ESM failure (the
`require()` succeeds), and it is not caused by our SDK usage or by any missing
"patch" on `pkce-challenge`. It is purely n8n's loader treating a dependency's
internal file as a node class. n8n's own bundled MCP node is immune only because
**installed** packages are loaded by `PackageDirectoryLoader`, which reads the
`n8n.nodes` array from `package.json` and loads **only those declared files** —
never a recursive glob. Same dependency, different loader.

### How the current design fixes it

The node ships as **one** `*.node.js` file (our real node) with **no `node_modules`
at all** — every runtime dependency is resolved from the host (see Architecture),
so there is nothing for the recursive glob to match except our node, whose class
name matches its export. `deploy.sh` deletes `node_modules` after the build and
**hard-fails the deploy** if any `*.node.js` exists outside the one declared node
file, so a future dependency that ships such a file can never silently reach n8n.

(Historically the crash was caused by a *vendored* `pkce-challenge/dist/index.node.js`
— a transitive dependency of a bundled MCP SDK — being globbed as a bogus node.
Reusing the host MCP machinery removed that dependency from the package entirely, so
the crash surface is gone at the root, not just papered over.)

The `external` list in `tsup.config.ts` keeps `n8n-workflow`, `n8n-core`,
`@langchain/core`, `@n8n/ai-utilities`, and `@n8n/n8n-nodes-langchain` unbundled: the
host provides them and their class identity matters (`instanceof` /
`isLangChainTool` checks), so a bundled copy would break tool attachment.

## License

MIT — see [LICENSE](./LICENSE).
