import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildHonoApp } from '../app';
import { authorizeStartFunction } from './start';

afterEach(() => vi.unstubAllEnvs());

describe('Start functions share Hono authorization', () => {
  const request = (token?: string) =>
    new Request('http://isolated.test/_serverFn/operation', {
      method: 'POST',
      headers: token ? { 'x-internal-token': token } : {},
      body: JSON.stringify({ token: 'body-is-not-authority', nested: { grant: true } }),
    });

  it.each([undefined, '', 'wrong', 'test-token-extra'])(
    'rejects token %s before consulting DB',
    async (token) => {
      vi.stubEnv('INTERNAL_TOKEN', 'test-token');
      const epochGate = vi.fn(async () => ({ runnable: true }));
      const app = buildHonoApp([], { epochGate });
      const denied = await authorizeStartFunction(app, request(token));
      expect(denied?.status).toBe(401);
      expect(await denied?.json()).toEqual({ error: 'unauthorized' });
      expect(epochGate).not.toHaveBeenCalled();
    },
  );
});
