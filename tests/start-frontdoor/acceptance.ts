import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { capabilities } from '@/capabilities';
import type { CapabilityManifest } from '@/kernel/manifest';
import { UI_SURFACES } from '@/kernel/ui-surfaces';
import { buildHonoApp } from '../../server/app';
import { createFrontdoor } from '../../server/frontdoor';

// Only a TEST listener: no env loading, DB, worker, runtime recovery or model calls.
const token = 'yuk1352-isolated-fixture-token';
process.env.INTERNAL_TOKEN = token;
let streamClosed = false;
const fixture: CapabilityManifest = {
  name: 'frontdoor_test',
  description: 'Isolated transport acceptance; no domain mutation',
  api: {
    routes: [
      ...(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const).map((method) => ({
        method,
        path: '/api/frontdoor-test/[id]',
        load: async () => async (request: Request, params: Record<string, string>) =>
          Response.json({
            method: request.method,
            id: params.id,
            search: new URL(request.url).search,
            body: await request.text(),
          }),
      })),
      {
        method: 'GET',
        path: '/api/frontdoor-stream',
        load: async () => async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                streamClosed = false;
                controller.enqueue(new TextEncoder().encode('event: chunk\ndata: first\n\n'));
                setTimeout(() => {
                  controller.enqueue(new TextEncoder().encode('event: done\ndata: last\n\n'));
                  streamClosed = true;
                  controller.close();
                }, 300);
              },
            }),
            { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } },
          ),
      },
    ],
  },
};
const api = buildHonoApp([...capabilities, fixture], {
  epochGate: async () => ({ runnable: true }),
});
const fetchFrontdoor = await createFrontdoor(api, 'web/dist');
const listener = serve({ fetch: fetchFrontdoor, hostname: '127.0.0.1', port: 18952 });
await new Promise<void>((resolve) => listener.once('listening', resolve));
const base = 'http://127.0.0.1:18952';
const headers = { 'x-internal-token': token };
const get = (path: string, init?: RequestInit) => fetch(base + path, init);
try {
  assert.equal((await get('/api/health')).status, 200);
  assert.equal((await get('/api/auth/check')).status, 401);
  assert.equal(
    (await get('/api/auth/check', { headers: { 'x-internal-token': 'wrong' } })).status,
    401,
  );
  assert.equal((await get('/api/auth/check', { headers })).status, 200);
  assert.equal((await get('/api/missing', { headers })).status, 404);
  assert.deepEqual(await (await get('/api/missing', { headers })).json(), { error: 'not_found' });
  assert.equal((await get('/api', { headers })).status, 404);
  const document = await (await get('/api/openapi.json', { headers })).json();
  assert.equal(document.openapi, '3.0.3');

  const postman: Array<{ path: string; methods: Array<{ method: string }> }> = JSON.parse(
    await readFile('postman/api-endpoints.json', 'utf8'),
  );
  let postmanAuthChecks = 0;
  for (const endpoint of postman) {
    if (endpoint.path === '/api/health' || endpoint.path === '/api/ready') continue;
    for (const method of endpoint.methods) {
      const path = endpoint.path.replace(/\[[^\]]+\]/g, 'fixture-id');
      const response = await get(path, { method: method.method });
      assert.equal(response.status, 401, `${method.method} ${path}`);
      postmanAuthChecks++;
    }
  }
  const body = JSON.stringify({
    text: '嵌套长文、边界与歧义。'.repeat(1000),
    nested: { values: ['α', null, { version: 7 }] },
  });
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    const sentBody = method === 'GET' ? undefined : body;
    const response = await get('/api/frontdoor-test/fixture-id?q=%E6%B5%8B%E8%AF%95', {
      method,
      headers,
      body: sentBody,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      method,
      id: 'fixture-id',
      search: '?q=%E6%B5%8B%E8%AF%95',
      body: sentBody ?? '',
    });
  }
  const response = await get('/api/frontdoor-stream', { headers });
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const reader = response.body?.getReader();
  assert.ok(reader);
  const first = await reader.read();
  assert.ok(new TextDecoder().decode(first.value).includes('data: first'));
  assert.equal(streamClosed, false, 'first bytes arrive before stream completion');
  let rest = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    rest += new TextDecoder().decode(chunk.value);
  }
  assert.ok(rest.includes('data: last'));
  for (const method of ['GET', 'POST']) {
    assert.equal((await get('/_serverFn/not-shipped', { method })).status, 401);
  }
  // No production function is introduced merely to create an acceptance endpoint.
  const fenced = buildHonoApp([], {
    epochGate: async () => ({ runnable: false, reason: 'unavailable' }),
  });
  const fencedFrontdoor = await createFrontdoor(fenced, 'web/dist');
  assert.equal(
    (await fencedFrontdoor(new Request(`${base}/_serverFn/not-shipped`, { headers }))).status,
    503,
  );

  for (const surface of UI_SURFACES) {
    const path = surface.route.replace(/\$[A-Za-z]+/g, 'fixture-id');
    const page = await get(`${path}?acceptance=1`);
    assert.equal(page.status, 200, path);
    assert.ok((await page.text()).includes('<div id="root"></div>'), path);
  }
  const html = await (await get('/today')).text();
  const asset = html.match(/src="(\/assets\/[^" ]+\.js)"/)?.[1];
  assert.ok(asset);
  assert.ok((await get(asset)).headers.get('content-type')?.includes('javascript'));
  assert.equal((await get('/assets/not-found.js')).status, 404);
  const startChunk = (await readdir('dist/start/client/assets')).find((file) =>
    file.endsWith('.js'),
  );
  assert.ok(startChunk);
  assert.equal((await get(`/_build/assets/${startChunk}`)).status, 200);
  assert.equal((await get('/_build/assets/not-found.js')).status, 404);
  const head = await get('/today', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await get('/today', { method: 'POST', body: 'not-a-command' })).status, 404);
  const clientCanaries = [
    'yuk1352-canary-openai',
    'yuk1352-canary-anthropic',
    'yuk1352-canary-r2',
    'yuk1352-canary-token',
  ];
  let clientFilesScanned = 0;
  const clientDigest = createHash('sha256');
  async function scanClient(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await scanClient(path);
        continue;
      }
      const bytes = await readFile(path);
      for (const canary of clientCanaries)
        assert.equal(bytes.includes(canary), false, `secret canary in ${path}`);
      clientDigest.update(path).update(bytes);
      clientFilesScanned++;
    }
  }
  await scanClient('web/dist');
  await scanClient('dist/start/client');
  const report = {
    status: 'PASS',
    base,
    postmanAuthChecks,
    spaSurfaces: UI_SURFACES.length,
    methods: 5,
    clientFilesScanned,
    clientCanariesAbsent: clientCanaries.length,
    clientDigest: clientDigest.digest('hex'),
    streamBeforeCompletion: true,
    serverFunctionUnauthenticated: 401,
    serverFunctionFenced: 503,
    scope:
      'built Start + original SPA + Hono manifests; controlled epoch, no business DB/runtime acceptance',
  };
  console.log(JSON.stringify(report));
  if (process.argv.includes('--serve')) {
    console.log('TEST browser listener remains available; Ctrl-C closes only this listener.');
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
  }
} finally {
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
}
