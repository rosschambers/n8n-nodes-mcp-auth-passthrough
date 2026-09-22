import { defineConfig } from 'tsup';

/**
 * Bundle the node into a SINGLE self-contained CommonJS file.
 *
 * Why this exists (do not revert to plain `tsc`):
 *
 * n8n loads packages pointed at by N8N_CUSTOM_EXTENSIONS with its
 * CustomDirectoryLoader, which runs `fast-glob('**\/*.node.js', { cwd:
 * <extension dir> })` — a RECURSIVE glob with no node_modules exclusion. For
 * every match it derives a class name from the filename (the part before the
 * first dot) and executes, inside a vm sandbox,
 * `new (require('<file>').<ClassName>)()`.
 *
 * @modelcontextprotocol/sdk pulls in `pkce-challenge`, whose Node build is
 * named `dist/index.node.js`. When our runtime deps live in a vendored
 * node_modules next to the mounted node, that file matches the glob. n8n then
 * treats it as a node: className becomes `index` (from `index.node.js`), it
 * require()s the file (Node 24 CAN require an ESM module and returns a
 * namespace object), finds no `.index` export, and `new undefined()` throws
 * `TypeError: require(...).index is not a constructor`. There is no try/catch
 * around this in the custom-extension path, so it crash-loops the whole n8n
 * process.
 *
 * Bundling everything into one CJS file means there is NO separate
 * pkce-challenge module on disk to be globbed or required — the ESM source is
 * transpiled and inlined. The only `*.node.js` file under the mounted
 * directory becomes our real node, whose class name matches.
 *
 * See README.md ("n8n loader caveat") for the full write-up.
 */
export default defineConfig({
	entry: {
		// Output path MUST match package.json > n8n.nodes exactly.
		'nodes/McpClientToolAuthPassthrough/McpClientToolAuthPassthrough.node':
			'nodes/McpClientToolAuthPassthrough/McpClientToolAuthPassthrough.node.ts',
	},
	format: ['cjs'],
	platform: 'node',
	target: 'node20',
	bundle: true,
	// One self-contained file. No shared chunks that could emit extra files.
	splitting: false,
	// Do not emit sourcemaps or .d.ts — keep the mounted directory free of any
	// stray sibling files (and, defensively, of anything ending in .node.js).
	sourcemap: false,
	dts: false,
	clean: true,
	outDir: 'dist',
	// Keep n8n-workflow EXTERNAL: the host container provides it, and n8n
	// inspects some of its exports (NodeConnectionTypes, NodeOperationError) by
	// identity — bundling our own copy would break those checks.
	external: ['n8n-workflow'],
	// tsup externalizes everything listed in `dependencies` / `peerDependencies`
	// by DEFAULT. That is the trap: without this, the MCP SDK stays a bare
	// `require`, the vendored node_modules (with pkce-challenge's index.node.js)
	// has to ship, and the crash returns. Force the runtime libraries to be
	// INLINED so nothing but n8n-workflow is required at runtime.
	noExternal: [/@modelcontextprotocol\/sdk/, /^zod/, /pkce-challenge/],
});
