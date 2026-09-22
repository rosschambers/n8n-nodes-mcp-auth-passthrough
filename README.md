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
npm run build      # bundles nodes/ into a single self-contained dist/ CJS file (tsup)
npm run typecheck  # type-check only (tsc --noEmit); the build no longer type-checks
npm test           # runs the test suite
```

## Build: this package MUST be bundled — do NOT revert to plain `tsc`

The build (`npm run build`) uses **tsup** (esbuild) to compile the node into a
**single, self-contained CommonJS file** with the Model Context Protocol SDK,
`zod`, and `pkce-challenge` all **inlined**. This is deliberate and load-bearing.
Do not "simplify" it back to `tsc` + a vendored `node_modules`.

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

### How bundling fixes it

Bundling produces **one** `*.node.js` file (our real node) and **no separate
`pkce-challenge` module on disk** — the ESM source is transpiled and inlined into
the bundle. There is nothing stray for the glob to match, so the loader only ever
sees our node, whose class name matches its export. The `deploy.sh` in
`serve-n8n` additionally deletes `node_modules` after the build and **hard-fails
the deploy** if any `*.node.js` exists outside the one declared node file, so a
future dependency that ships such a file can never silently reach n8n.

`n8n-workflow` is kept **external** (not bundled): the host container provides it,
and n8n inspects some of its exports (`NodeConnectionTypes`, `NodeOperationError`)
by identity, so a bundled copy would break those checks. Everything else is
inlined.

> `zod` is pinned to `^3.25.0` (not the older `^3.23.8`) because the MCP SDK
> `require`s the `zod/v4` subpath, which only exists in zod `>= 3.25.0`. An older
> resolution would crash at runtime with `Cannot find module 'zod/v4'`.

## License

MIT — see [LICENSE](./LICENSE).
