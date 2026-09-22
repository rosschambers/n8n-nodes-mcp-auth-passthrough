import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import type {
	INodeType,
	INodeTypeDescription,
	ISupplyDataFunctions,
	SupplyData,
} from 'n8n-workflow';

import { getAuthHeaders, getNodeConfig, resolveHostMcpMachinery } from './shared';

export class McpClientToolAuthPassthrough implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'MCP Client Tool (Auth Passthrough)',
		name: 'mcpClientToolAuthPassthrough',
		icon: 'fa:plug',
		group: ['transform'],
		version: 1,
		description:
			'Connects to a Model Context Protocol server and exposes its tools to an AI agent, with support for resolving the bearer token from a per-item expression instead of a static credential.',
		defaults: {
			name: 'MCP Client Tool (Auth Passthrough)',
		},
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Tools'],
			},
		},
		inputs: [],
		outputs: [NodeConnectionTypes.AiTool],
		outputNames: ['Tool'],
		usableAsTool: true,
		credentials: [
			{
				name: 'httpBearerAuth',
				required: false,
				displayOptions: {
					show: {
						authentication: ['bearerAuth'],
					},
				},
			},
		],
		properties: [
			{
				displayName: 'Endpoint URL',
				name: 'endpointUrl',
				type: 'string',
				default: '',
				placeholder: 'https://example.com/mcp',
				description: 'The URL of the MCP server to connect to',
				required: true,
			},
			{
				displayName: 'Server Transport',
				name: 'serverTransport',
				type: 'options',
				options: [
					{
						name: 'HTTP Streamable',
						value: 'httpStreamable',
					},
					{
						name: 'Server-Sent Events (SSE)',
						value: 'sse',
					},
				],
				default: 'httpStreamable',
				description: 'The transport used to communicate with the MCP server',
			},
			{
				displayName: 'Authentication',
				name: 'authentication',
				type: 'options',
				options: [
					{
						name: 'None',
						value: 'none',
					},
					{
						name: 'Bearer Auth',
						value: 'bearerAuth',
					},
					{
						name: 'Auth Passthrough (Expression)',
						value: 'authPassthrough',
					},
				],
				default: 'none',
				description: 'The way to authenticate with the MCP server',
			},
			{
				displayName: 'Bearer Token (Expression)',
				name: 'authPassthroughToken',
				type: 'string',
				typeOptions: {
					password: true,
				},
				default: '',
				description:
					'An expression that resolves to the bearer token to send with each request, for example {{ $(\'Token Refresh\').item.json.accessToken }}. Resolved per item at execution time instead of coming from a static credential.',
				displayOptions: {
					show: {
						authentication: ['authPassthrough'],
					},
				},
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Timeout',
						name: 'timeout',
						type: 'number',
						default: 60000,
						description: 'Time in milliseconds to wait for the MCP server to respond',
					},
				],
			},
		],
	};

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const node = this.getNode();
		const config = getNodeConfig(this, itemIndex);

		// Reuse the HOST n8n's own MCP machinery so the tools we return are the
		// exact classes the ToolsAgent expects (host DynamicStructuredTool +
		// StructuredToolkit). Only the auth headers differ from the stock node.
		const host = resolveHostMcpMachinery(this);

		const { headers } = await getAuthHeaders(this, config.authentication, itemIndex);

		const connection = await host.connectMcpClient({
			serverTransport: config.serverTransport,
			endpointUrl: config.endpointUrl,
			headers,
			name: node.type,
			version: node.typeVersion,
		});

		if (!connection.ok) {
			this.logger.error('McpClientToolAuthPassthrough: Failed to connect to MCP Server', {
				error: connection.error,
			});
			const mappedError = host.mapToNodeOperationError(node, connection.error);
			this.addOutputData(NodeConnectionTypes.AiTool, itemIndex, mappedError);
			throw mappedError;
		}

		const client = connection.result;
		const mcpTools = await host.getAllTools(client);

		if (!mcpTools?.length) {
			const emptyError = new NodeOperationError(node, 'MCP Server returned no tools', {
				itemIndex,
				description:
					'Connected successfully to your MCP server but it returned an empty list of tools.',
			});
			this.addOutputData(NodeConnectionTypes.AiTool, itemIndex, emptyError);
			throw emptyError;
		}

		// Mirror the stock supplyData tool-wrapping EXACTLY: each MCP tool becomes
		// a host DynamicStructuredTool (with a real zod schema, so it passes
		// LangChain's isLangChainTool / the `strict` setter), wrapped by the host
		// logWrapper, then collected into the host StructuredToolkit so
		// n8n-core's `getConnectedTools` recognises and unwraps it.
		const tools = mcpTools.map((tool) =>
			host.logWrapper(
				host.mcpToolToDynamicTool(
					tool,
					host.createCallTool(tool.name, client, config.timeout, (errorMessage) => {
						const error = new NodeOperationError(node, errorMessage, { itemIndex });
						void this.addOutputData(NodeConnectionTypes.AiTool, itemIndex, error);
						this.logger.error(
							`McpClientToolAuthPassthrough: Tool "${tool.name}" failed to execute`,
							{ error },
						);
					}),
				),
				this,
			),
		);

		const toolkit = new host.StructuredToolkit(tools);

		return {
			response: toolkit,
			closeFunction: async () => {
				await (client as { close: () => Promise<void> }).close();
			},
		};
	}
}
