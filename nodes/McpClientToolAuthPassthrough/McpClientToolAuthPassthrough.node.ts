import { NodeConnectionTypes } from 'n8n-workflow';
import type {
	INodeType,
	INodeTypeDescription,
	ISupplyDataFunctions,
	SupplyData,
} from 'n8n-workflow';

import { connectMcpClient, getAuthHeaders, getNodeConfig } from './shared';

/**
 * A minimal wrapper around a single MCP tool, shaped so it can later be
 * adapted into a LangChain `StructuredTool` (or any other agent-tool
 * interface) without changing how it is produced here.
 *
 * TASK 2 note: this stub intentionally stays framework-agnostic. Swap the
 * `invoke` implementation, or wrap instances of this class in a LangChain
 * `DynamicStructuredTool`, once the full toolkit wiring is added.
 */
export class McpToolStub {
	public readonly name: string;

	public readonly description: string;

	private readonly callTool: (args: Record<string, unknown>) => Promise<unknown>;

	constructor(
		name: string,
		description: string,
		callTool: (args: Record<string, unknown>) => Promise<unknown>,
	) {
		this.name = name;
		this.description = description;
		this.callTool = callTool;
	}

	public async invoke(args: Record<string, unknown>): Promise<unknown> {
		return this.callTool(args);
	}
}

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
		const config = await getNodeConfig(this, itemIndex);
		const { headers } = await getAuthHeaders(this, config.authentication, itemIndex);

		const { client, close } = await connectMcpClient({
			serverTransport: config.serverTransport,
			endpointUrl: config.endpointUrl,
			headers,
			name: 'n8n-mcp-client-tool-auth-passthrough',
			version: '0.1.0',
			timeout: config.timeout,
		});

		const { tools } = await client.listTools();

		// TASK 2 leaves this wrapping minimal on purpose: each MCP tool is
		// exposed as a framework-agnostic `McpToolStub`. Replace this with the
		// full LangChain `DynamicStructuredTool` wiring (JSON schema to Zod
		// conversion, output parsing, etc.) once the auth-passthrough mode is
		// implemented and needs to be exercised end to end.
		const wrappedTools = tools.map((tool) => {
			return new McpToolStub(tool.name, tool.description ?? '', async (args) => {
				return client.callTool({ name: tool.name, arguments: args });
			});
		});

		return {
			response: wrappedTools,
			closeFunction: close,
		};
	}
}
