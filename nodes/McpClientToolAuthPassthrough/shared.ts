import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ISupplyDataFunctions } from 'n8n-workflow';

/**
 * Transport used to reach the MCP server.
 * `sse` (Server-Sent Events) support is intentionally out of scope for this
 * initial scaffold and can be added alongside `httpStreamable` later; the
 * type is kept here so the `serverTransport` node parameter and this type
 * stay in lockstep.
 */
export type McpServerTransport = 'httpStreamable' | 'sse';

/**
 * Supported authentication modes for the node's `authentication` parameter.
 *
 * TASK 2: add `'authPassthrough'` to this union once the per-item token
 * expression parameter is implemented.
 */
export type McpAuthenticationMode = 'none' | 'bearerAuth';

export interface McpNodeConfig {
	authentication: McpAuthenticationMode;
	timeout: number;
	serverTransport: McpServerTransport;
	endpointUrl: string;
}

export interface McpAuthHeadersResult {
	headers: Record<string, string>;
}

/**
 * Reads the node's parameters for the given item and returns a normalized
 * configuration object used to connect to the MCP server.
 */
export async function getNodeConfig(
	context: ISupplyDataFunctions,
	itemIndex: number,
): Promise<McpNodeConfig> {
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
 * `itemIndex` is threaded through now, even though only `none` and
 * `bearerAuth` are implemented, because TASK 2's `authPassthrough` case
 * needs it to resolve a per-item expression parameter (for example
 * `Bearer {{ $json.token }}`) via `context.getNodeParameter(..., itemIndex)`.
 *
 * TASK 2: add a case for `'authPassthrough'` here that reads a new
 * `authPassthroughHeaderValue` (or similarly named) string parameter with
 * expression support, resolved per-item via `itemIndex`, and returns it
 * verbatim (or wrapped as `Bearer <token>`) as the `Authorization` header.
 */
export async function getAuthHeaders(
	context: ISupplyDataFunctions,
	authentication: McpAuthenticationMode,
	itemIndex: number,
): Promise<McpAuthHeadersResult> {
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
		// TASK 2: case 'authPassthrough': { ... }
		default: {
			return { headers: {} };
		}
	}
}

export interface ConnectMcpClientOptions {
	serverTransport: McpServerTransport;
	endpointUrl: string;
	headers: Record<string, string>;
	name: string;
	version: string;
	timeout: number;
}

export interface ConnectedMcpClient {
	client: Client;
	close: () => Promise<void>;
}

/**
 * Connects to an MCP server over the configured transport and returns the
 * connected client along with a close function.
 *
 * Only `httpStreamable` is implemented in this scaffold; `sse` is rejected
 * with a clear error so the option is visible in the UI without silently
 * doing the wrong thing.
 */
export async function connectMcpClient(
	options: ConnectMcpClientOptions,
): Promise<ConnectedMcpClient> {
	if (options.serverTransport !== 'httpStreamable') {
		throw new Error(
			`Server transport "${options.serverTransport}" is not yet implemented in this scaffold. Use "httpStreamable".`,
		);
	}

	const endpoint = new URL(options.endpointUrl);
	const transport = new StreamableHTTPClientTransport(endpoint, {
		requestInit: {
			headers: options.headers,
		},
	});

	const client = new Client(
		{ name: options.name, version: options.version },
		{ capabilities: {} },
	);

	await client.connect(transport);

	return {
		client,
		close: async () => {
			await client.close();
		},
	};
}
