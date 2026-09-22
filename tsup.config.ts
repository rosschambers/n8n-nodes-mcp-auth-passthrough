import { defineConfig } from 'tsup';

/**
 * Bundle the node into a SINGLE self-contained CommonJS file.
 *
 * Two distinct reasons this config looks the way it does:
 *
 * 1. WHY BUNDLE AT ALL (do not revert to plain `tsc` + a vendored node_modules)
 *
 *    n8n loads packages pointed at by N8N_CUSTOM_EXTENSIONS with its
 *    CustomDirectoryLoader, which runs `fast-glob('**\/*.node.js', { cwd:
 *    <extension dir> })` — a RECURSIVE glob with no node_modules exclusion. For
 *    every match it derives a class name from the filename and executes, in a
 *    vm sandbox, `new (require('<file>').<ClassName>)()`. A vendored dependency
 *    that ships a `*.node.js` file (pkce-challenge ships `dist/index.node.js`)
 *    is then loaded as a bogus node and crash-loops the whole n8n process. A
 *    single bundled file with NO shipped node_modules removes that surface.
 *    See README.md ("n8n loader caveat").
 *
 * 2. WHY (ALMOST) EVERYTHING IS EXTERNAL — identity with the host
 *
 *    This node does NOT bundle the MCP SDK. Instead its supplyData reuses the
 *    HOST n8n's OWN @n8n/n8n-nodes-langchain MCP machinery (connectMcpClient,
 *    mcpToolToDynamicTool, createCallTool), the host @n8n/ai-utilities
 *    (logWrapper), the host n8n-core (StructuredToolkit) and the host
 *    @langchain/core, so the tools it returns are the EXACT classes the
 *    ToolsAgent expects. If we bundled our own copies, LangChain's
 *    `convertToOpenAITool` would not recognise our tool (isLangChainTool ->
 *    false) and crash with "Cannot set properties of undefined (setting
 *    'strict')", and n8n-core's `getConnectedTools` would fail its
 *    `instanceof StructuredToolkit` check. Those modules are therefore marked
 *    EXTERNAL and resolved from the host at runtime (the deploy adds
 *    /usr/local/lib/node_modules/n8n/node_modules to NODE_PATH). We only bundle
 *    our own small source; there are no runtime dependencies left to inline.
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
	// Everything the node touches at runtime is provided by the HOST n8n and
	// must be the host's own instances (see reason 2 above). Keep them external;
	// they resolve from the host node_modules via NODE_PATH. The stock MCP
	// helpers are loaded dynamically by absolute path in shared.ts, so they do
	// not appear here.
	external: [
		'n8n-workflow',
		'n8n-core',
		'@langchain/core',
		'@n8n/ai-utilities',
		'@n8n/n8n-nodes-langchain',
	],
});
