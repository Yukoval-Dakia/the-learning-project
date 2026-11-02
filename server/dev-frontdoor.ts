// Dev-only Web front door (RW_FRONTDOOR=dev, started by `pnpm dev:local`): the Vite dev server
// runs in middleware mode inside the API process on the API port, so pages get HMR while the
// origin, cookies, tokens and relative /api URLs stay identical to the built front door.
// Production never loads this module (server/index.ts imports it only for RW_FRONTDOOR=dev).
import { type RequestListener, type Server, createServer as createHttpServer } from 'node:http';
import { resolve } from 'node:path';
import type { Hono } from 'hono';
import { type Plugin, createServer as createViteServer, isRunnableDevEnvironment } from 'vite';
import { type StartEntryFetch, buildFrontdoor } from './frontdoor';

const START_SSR_ENTRY = 'virtual:tanstack-start-server-entry';
// vite.config.ts sets base '/_build/'; every Vite-owned URL (client modules, HMR socket) lives there.
const VITE_BASE = '/_build/';

// The production build stubs Node builtins that shared domain modules import (they are only called
// server-side); the dev client would otherwise throw on the import itself.
const STUB_ID = '\0dev-browser-node-crypto';
const browserNodeCryptoStub: Plugin = {
  name: 'dev-browser-node-crypto-stub',
  enforce: 'pre',
  applyToEnvironment: (environment) => environment.name === 'client',
  resolveId: (id) => (id === 'node:crypto' ? STUB_ID : undefined),
  load: (id) =>
    id === STUB_ID
      ? "export const createHash = () => { throw new Error('node:crypto is server-only'); };"
      : undefined,
};

export async function createViteFrontdoor(api: Hono) {
  const httpServer = createHttpServer();
  const vite = await createViteServer({
    configFile: resolve('server/start/vite.config.ts'),
    appType: 'custom',
    plugins: [browserNodeCryptoStub],
    server: { middlewareMode: true, hmr: { server: httpServer } },
  });
  httpServer.once('close', () => void vite.close());

  const ssr = vite.environments.ssr;
  if (!isRunnableDevEnvironment(ssr)) throw new Error('Start SSR environment is not runnable');

  const fetch = buildFrontdoor(
    api,
    async (request, options) => {
      try {
        const entry = await ssr.runner.import<{ default: { fetch: StartEntryFetch } }>(
          START_SSR_ENTRY,
        );
        return await entry.default.fetch(request, options);
      } catch (error) {
        if (error instanceof Error) vite.ssrFixStacktrace(error);
        throw error;
      }
    },
    resolve('public'),
  );

  // Hono's serve() accepts a server factory; Vite's middleware answers its own URLs first,
  // everything else (pages, /api/*) goes through the front door and the Hono app.
  const createServer = ((_options: unknown, listener: RequestListener): Server => {
    httpServer.on('request', (req, res) => {
      if (req.url?.startsWith(VITE_BASE)) vite.middlewares(req, res, () => listener(req, res));
      else listener(req, res);
    });
    return httpServer;
  }) as typeof createHttpServer;
  return { fetch, createServer };
}
