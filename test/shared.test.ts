import { describe, expect, it } from 'vitest';

import { getAuthHeaders } from '../nodes/McpClientToolAuthPassthrough/shared';

/**
 * Placeholder test harness. TASK 2 replaces/extends this file with real
 * coverage for `getAuthHeaders`'s `authPassthrough` case, driven by TDD.
 */
describe('getAuthHeaders', () => {
	it('returns no headers for the "none" authentication mode', async () => {
		const fakeContext = {} as Parameters<typeof getAuthHeaders>[0];

		const result = await getAuthHeaders(fakeContext, 'none', 0);

		expect(result).toEqual({ headers: {} });
	});
});
