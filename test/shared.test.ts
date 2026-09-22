import { NodeOperationError } from 'n8n-workflow';
import type { INode, ISupplyDataFunctions } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import { getAuthHeaders } from '../nodes/McpClientToolAuthPassthrough/shared';

const fakeNode: INode = {
	id: 'fake-node-id',
	name: 'Fake Node',
	type: 'n8n-nodes-mcp-auth-passthrough.mcpClientToolAuthPassthrough',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

function createMockContext(options: {
	authPassthroughToken?: string;
	credentials?: Record<string, unknown> | null;
}): ISupplyDataFunctions {
	return {
		getNode: () => fakeNode,
		getNodeParameter: (parameterName: string) => {
			if (parameterName === 'authPassthroughToken') {
				return options.authPassthroughToken ?? '';
			}
			return '';
		},
		getCredentials: async () => {
			if (!options.credentials) {
				throw new Error('No credentials configured');
			}
			return options.credentials;
		},
	} as unknown as ISupplyDataFunctions;
}

describe('getAuthHeaders', () => {
	it('returns no headers for the "none" authentication mode', async () => {
		const fakeContext = {} as Parameters<typeof getAuthHeaders>[0];

		const result = await getAuthHeaders(fakeContext, 'none', 0);

		expect(result).toEqual({ headers: {} });
	});

	it('returns a Bearer Authorization header from credentials for "bearerAuth" (regression)', async () => {
		const context = createMockContext({ credentials: { token: 'CREDTOK' } });

		const result = await getAuthHeaders(context, 'bearerAuth', 0);

		expect(result).toEqual({ headers: { Authorization: 'Bearer CREDTOK' } });
	});

	it('resolves the per-item expression token and returns it as a Bearer Authorization header for "authPassthrough"', async () => {
		const context = createMockContext({ authPassthroughToken: 'USERTOKEN123' });

		const result = await getAuthHeaders(context, 'authPassthrough', 0);

		expect(result).toEqual({ headers: { Authorization: 'Bearer USERTOKEN123' } });
	});

	it('throws a NodeOperationError instead of silently returning unauthenticated headers when the "authPassthrough" token is empty', async () => {
		const context = createMockContext({ authPassthroughToken: '' });

		await expect(getAuthHeaders(context, 'authPassthrough', 0)).rejects.toThrow(
			NodeOperationError,
		);
		await expect(getAuthHeaders(context, 'authPassthrough', 0)).rejects.toThrow(
			/token is empty/i,
		);
	});
});
