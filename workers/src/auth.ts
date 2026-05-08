import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './types';

export const internalAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = c.req.header('x-internal-token');
  if (!token || token !== c.env.INTERNAL_TOKEN) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
};
