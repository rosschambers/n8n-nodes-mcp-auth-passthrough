import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	ISupplyDataFunctions,
	SupplyData,
} from 'n8n-workflow';

import { connectAndGetTools, getNodeConfig, resolveHostMcpMachinery } from './shared';

export class McpClientToolAuthPassthrough implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'MCP Client Tool (Auth Passthrough)',
		name: 'mcpClientToolAuthPassthrough',
		icon: 'fa:plug',
		// A native AI sub-node (a tool PROVIDER), exactly like the stock
		// McpClientTool: group 'output', a single AiTool output, and a
		// `supplyData` method that hands tools to the agent. It must NOT set
		// `usableAsTool` — that flag is for regular ACTION nodes you also want
		// exposed as a tool, and it makes n8n auto-generate a `<name>Tool`
		// action-wrapper (via convertNodeToAiTool) whose tool is driven through
		// `createNodeAsTool` -> the node's `execute` method. Because this node has
		// `supplyData` and NO `execute`, that path throws
		// `The node "..." has a "supplyData" method but no "execute" method`
		// (n8n-core workflow-execute runNode) when the agent invokes the tool.
		// Removing `usableAsTool` makes this a pure supplyData tool provider, and
		// the agent routes tool calls through the toolkit supplyData returns —
		// never runNode. See README ("AI sub-node classification").
		group: ['output'],
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
		outputs: [{ type: NodeConnectionTypes.AiTool, displayName: 'Tools' }],
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

		const { client, mcpTools, error } = await connectAndGetTools(this, host, config, itemIndex);

		if (error) {
			this.logger.error('McpClientToolAuthPassthrough: Failed to connect to MCP Server', {
				error,
			});
			this.addOutputData(NodeConnectionTypes.AiTool, itemIndex, error);
			throw error;
		}

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
						const callError = new NodeOperationError(node, errorMessage, { itemIndex });
						void this.addOutputData(NodeConnectionTypes.AiTool, itemIndex, callError);
						this.logger.error(
							`McpClientToolAuthPassthrough: Tool "${tool.name}" failed to execute`,
							{ error: callError },
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
				await client!.close();
			},
		};
	}

	/**
	 * Tool INVOCATION path (required in addition to supplyData).
	 *
	 * The AI Agent (ToolsAgent V3) does NOT call the toolkit tool's `func`
	 * inline. When the LLM emits a tool call, the agent's `createEngineRequests`
	 * turns it into an `ExecutionNodeAction` targeting this node
	 * (`sourceNodeName`, type `ai_tool`); the engine sets `rewireOutputLogTo` and
	 * runs the node via `runNode` — which requires an `execute` method. A node
	 * with only `supplyData` throws
	 * `The node "..." has a "supplyData" method but no "execute" method`.
	 * The stock McpClientTool has BOTH methods; this mirrors its `execute`
	 * exactly, reading the tool name from `item.json.tool` and the remaining keys
	 * as arguments, then calling `client.callTool`.
	 */
	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const node = this.getNode();
		const items = this.getInputData();
		const host = resolveHostMcpMachinery(this);
		const returnData: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			const item = items[itemIndex];
			const config = getNodeConfig(this, itemIndex);
			const { client, mcpTools, error } = await connectAndGetTools(this, host, config, itemIndex);

			if (error) {
				throw error;
			}
			if (!mcpTools?.length) {
				throw new NodeOperationError(node, 'MCP Server returned no tools', { itemIndex });
			}

			try {
				for (const tool of mcpTools) {
					if (!item.json.tool || typeof item.json.tool !== 'string') {
						throw new NodeOperationError(
							node,
							'Tool name not found in item.json.tool or item.tool',
							{ itemIndex },
						);
					}
					const toolName = item.json.tool;
					if (toolName !== tool.name) {
						continue;
					}

					const { tool: _toolName, ...toolArguments } = item.json;
					const schema = tool.inputSchema;
					const sanitizedToolArguments =
						schema.additionalProperties !== true
							? host.pick(
									toolArguments as Record<string, unknown>,
									Object.keys(schema.properties ?? {}),
								)
							: (toolArguments as Record<string, unknown>);

					const result = await client!.callTool(
						{ name: tool.name, arguments: sanitizedToolArguments as Record<string, unknown> },
						host.CallToolResultSchema,
						{ timeout: config.timeout },
					);

					returnData.push({
						json: { response: result.content } as IDataObject,
						pairedItem: { item: itemIndex },
					});
				}
			} finally {
				await client!.close();
			}
		}

		return [returnData];
	}
}
