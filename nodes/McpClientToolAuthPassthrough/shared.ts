import { createRequire } from 'node:module';
import path from 'node:path';

import { NodeOperationError } from 'n8n-workflow';
import type { ISupplyDataFunctions } from 'n8n-workflow';

/**
 * Transport used to reach the MCP server. Mirrors the stock MCP Client Tool.
 */
export type McpServerTransport = 'httpStreamable' | 'sse';

/**
 * Supported authentication modes for this node's `authentication` parameter.
 * `none` / `bearerAuth` behave exactly like the stock node; `authPassthrough`
 * is our addition — the bearer token comes from a per-item expression.
 */
export type McpAuthenticationMode = 'none' | 'bearerAuth' | 'authPassthrough';

export interface McpNodeConfig {
	authentication: McpAuthenticationMode;
	timeout: number;
	serverTransport: McpServerTransport;
	endpointUrl: string;
}

/**
 * The subset of the host `@n8n/n8n-nodes-langchain` MCP machinery this node
 * reuses. We deliberately depend on the HOST's already-loaded copies (never a
 * bundled one) so the tools we return are the SAME classes the ToolsAgent
 * expects — see resolveHostMcpMachinery() for why identity matters.
 */
export interface HostMcpMachinery {
	// from @n8n/n8n-nodes-langchain/dist/nodes/mcp/shared/utils.js
	connectMcpClient: (options: {
		serverTransport: McpServerTransport;
		endpointUrl: string;
		headers: Record<string, string>;
		name: string;
		version: number | string;
		onUnauthorized?: (headers: Record<string, string>) => Promise<Record<string, string> | null>;
	}) => Promise<
		| { ok: true; result: unknown }
		| { ok: false; error: { type: string; error: Error } }
	>;
	getAllTools: (client: unknown, cursor?: string) => Promise<Array<{ name: string; description?: string; inputSchema: unknown }>>;
	mapToNodeOperationError: (node: unknown, error: { type: string; error: Error }) => NodeOperationError;
	// from @n8n/n8n-nodes-langchain/dist/nodes/mcp/McpClientTool/utils.js
	mcpToolToDynamicTool: (tool: unknown, onCallTool: (args: Record<string, unknown>) => Promise<unknown>) => unknown;
	createCallTool: (
		name: string,
		client: unknown,
		timeout: number,
		onError: (errorMessage: string) => void,
	) => (args: Record<string, unknown>) => Promise<unknown>;
	// from @n8n/ai-utilities
	logWrapper: (tool: unknown, ctx: unknown) => unknown;
	// from n8n-core
	StructuredToolkit: new (tools: unknown[]) => unknown;
}

/**
 * Resolve the host n8n's OWN MCP tool machinery at runtime.
 *
 * WHY this exists (identity, not convenience):
 *
 * The ToolsAgent binds each tool to the model via LangChain's
 * `convertToOpenAITool`, which does (function_calling.cjs):
 *
 *     if (isLangChainTool(tool)) toolDef = { type: 'function', function: convertToOpenAIFunction(tool) };
 *     else                       toolDef = tool;
 *     if (fields?.strict !== undefined) toolDef.function.strict = fields.strict;
 *
 * If our tool is NOT a recognised LangChain tool, `toolDef = tool` has no
 * `.function`, so `toolDef.function.strict = ...` throws
 * "Cannot set properties of undefined (setting 'strict')" — the exact error
 * this node used to produce with its stub tools.
 *
 * Separately, n8n-core's `getConnectedTools` unwraps a tool node's response
 * with `if (toolOrToolkit instanceof StructuredToolkit) { ...spread tools... }`
 * — an `instanceof` check against the HOST's `n8n-core` class. A bundled
 * StructuredToolkit fails that check and the whole toolkit is mistaken for a
 * single malformed tool.
 *
 * Both problems vanish if we build the tools and the toolkit with the host's
 * OWN classes. So instead of reimplementing (and risking a different shape on
 * every n8n release), we import the stock MCP node's helpers and construct the
 * exact objects it does — overriding ONLY the auth headers.
 *
 * Resolution is upgrade-stable: `@n8n/n8n-nodes-langchain` is hoisted and
 * bare-resolvable, but its package `exports` map blocks deep subpath imports.
 * We therefore resolve the package.json (bare, no pnpm hash) and join the
 * internal dist path as an absolute file path, which bypasses the exports map.
 *
 * Requires the host node_modules on the module search path — the deploy sets
 * `NODE_PATH=/usr/local/lib/node_modules/n8n/node_modules` (see the node
 * README and serve-n8n docker-compose.yml). Without it these bare specifiers
 * do not resolve from a CUSTOM extension (verified).
 */
export function resolveHostMcpMachinery(context: ISupplyDataFunctions): HostMcpMachinery {
	// Use a require anchored at this module so NODE_PATH / the host node_modules
	// are consulted. `createRequire(import.meta.url)` is unavailable in the CJS
	// bundle; anchor on the current file instead.
	const requireFromHere = createRequire(__filename);

	const fail = (detail: string): never => {
		throw new NodeOperationError(
			context.getNode(),
			'MCP Client Tool (Auth Passthrough) could not load the host n8n MCP libraries.',
			{
				description:
					`${detail}\n\nThis node reuses the host n8n's own @n8n/n8n-nodes-langchain / ` +
					'n8n-core / @langchain/core so the tools it produces match what the AI ' +
					'Agent expects. Ensure NODE_PATH includes ' +
					'/usr/local/lib/node_modules/n8n/node_modules (set in serve-n8n/docker-compose.yml).',
			},
		);
	};

	let langchainPackageJson: string;
	try {
		langchainPackageJson = requireFromHere.resolve('@n8n/n8n-nodes-langchain/package.json');
	} catch (error) {
		return fail(`Cannot resolve @n8n/n8n-nodes-langchain: ${(error as Error).message}`);
	}
	const langchainRoot = path.dirname(langchainPackageJson);

	try {
		const mcpUtils = requireFromHere(
			path.join(langchainRoot, 'dist/nodes/mcp/McpClientTool/utils.js'),
		) as Pick<HostMcpMachinery, 'mcpToolToDynamicTool' | 'createCallTool'>;
		const sharedUtils = requireFromHere(
			path.join(langchainRoot, 'dist/nodes/mcp/shared/utils.js'),
		) as Pick<HostMcpMachinery, 'connectMcpClient' | 'getAllTools' | 'mapToNodeOperationError'>;
		const { logWrapper } = requireFromHere('@n8n/ai-utilities') as {
			logWrapper: HostMcpMachinery['logWrapper'];
		};
		const { StructuredToolkit } = requireFromHere('n8n-core') as {
			StructuredToolkit: HostMcpMachinery['StructuredToolkit'];
		};

		return {
			connectMcpClient: sharedUtils.connectMcpClient,
			getAllTools: sharedUtils.getAllTools,
			mapToNodeOperationError: sharedUtils.mapToNodeOperationError,
			mcpToolToDynamicTool: mcpUtils.mcpToolToDynamicTool,
			createCallTool: mcpUtils.createCallTool,
			logWrapper,
			StructuredToolkit,
		};
	} catch (error) {
		return fail(`Failed to load host MCP machinery: ${(error as Error).message}`);
	}
}

/**
 * Reads the node's parameters for the given item and returns a normalized
 * configuration object used to connect to the MCP server.
 */
export function getNodeConfig(
	context: ISupplyDataFunctions,
	itemIndex: number,
): McpNodeConfig {
	const authentication = context.getNodeParameter(
		'authentication',
		itemIndex,
		'none',
	) as McpAuthenticationMode;
	const serverTransport = context.getNodeParameter(
		'serverTransport',
		itemIndex,
		'httpStreamable',
	) as McpServerTransport;
	const endpointUrl = context.getNodeParameter('endpointUrl', itemIndex, '') as string;
	const timeout = context.getNodeParameter('options.timeout', itemIndex, 60000) as number;

	return {
		authentication,
		timeout,
		serverTransport,
		endpointUrl,
	};
}

/**
 * Resolves the HTTP headers to send with every MCP request, based on the
 * node's `authentication` mode.
 *
 * This is the ONLY behavioural difference from the stock MCP Client Tool: the
 * `authPassthrough` mode resolves a per-item expression parameter to the bearer
 * token, instead of reading a static credential. `none` and `bearerAuth` match
 * the stock node's semantics.
 */
export async function getAuthHeaders(
	context: ISupplyDataFunctions,
	authentication: McpAuthenticationMode,
	itemIndex: number,
): Promise<{ headers: Record<string, string> }> {
	switch (authentication) {
		case 'none': {
			return { headers: {} };
		}
		case 'bearerAuth': {
			const credentials = await context
				.getCredentials('httpBearerAuth', itemIndex)
				.catch(() => null);
			if (!credentials || typeof credentials.token !== 'string') {
				return { headers: {} };
			}
			return { headers: { Authorization: `Bearer ${credentials.token}` } };
		}
		case 'authPassthrough': {
			const token = context.getNodeParameter('authPassthroughToken', itemIndex, '') as string;
			if (!token || token.trim() === '') {
				throw new NodeOperationError(
					context.getNode(),
					'Auth Passthrough token is empty. Provide an expression that resolves to the bearer token.',
					{ itemIndex },
				);
			}
			return { headers: { Authorization: `Bearer ${token}` } };
		}
		default: {
			return { headers: {} };
		}
	}
}
