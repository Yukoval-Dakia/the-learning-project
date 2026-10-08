import { createMiddleware, createStart } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import type { FrontdoorContext } from './context';

// Every server-function HTTP call uses Hono's existing token AND DB epoch gate.
// Neither the header nor the configured secret is substituted or forwarded to a provider.
export async function authorizeStartFunction(api: FrontdoorContext['api'], request: Request) {
  const url = new URL('/api/auth/check', request.url);
  const response = await api.fetch(
    new Request(url, { headers: request.headers, signal: request.signal }),
  );
  return response.ok ? undefined : response;
}

export const functionAuth = createMiddleware().server(
  async ({ request, context, next, handlerType }) => {
    if (handlerType === 'serverFn') {
      const denied = await authorizeStartFunction(context.api, request);
      if (denied) return denied;
    }
    return next();
  },
);

// Server-internal calls (for example future SSR loaders) need the same gate as RPC.
const serverFunctionAuth = createMiddleware({ type: 'function' }).server(
  async ({ context, next }) => {
    const denied = await authorizeStartFunction(context.api, getRequest());
    if (denied) throw denied;
    return next();
  },
);

export const startInstance = createStart(() => ({
  requestMiddleware: [functionAuth],
  functionMiddleware: [serverFunctionAuth],
}));
