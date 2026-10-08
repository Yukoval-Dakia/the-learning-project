import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  adminConjectures,
  adminCost,
  adminCoverage,
  adminDetail,
  adminFailures,
  adminRuns,
} from '../../server/start/admin-test-fixtures';
import {
  AdminCostResponseSchema,
  AdminFailuresResponseSchema,
  AdminRunDetailResponseSchema,
  AdminRunsResponseSchema,
} from '../../src/capabilities/observability/api/admin-observability-contracts';
import {
  ConjectureScoresResponseSchema,
  CoverageLatticeResponseSchema,
} from '../../src/capabilities/observability/api/diagnostic-contracts';
import { ProposalPageResponseSchema } from '../../src/capabilities/shell/api/contracts';
import { ProposalDecisionResource } from '../../src/core/schema/proposal';
import { createApiFixtureScenario } from './api-fixtures';
import {
  documentAssets,
  readStartAssetManifest,
  startRouteAssets,
  verifyServedAsset,
} from './built-assets';
import {
  decodeRpcRequest,
  loadBuiltFunctionMap,
  matchesFixturePattern,
  parseBuiltFunctionMap,
  readProposalDecisionResponse,
  rpcFulfillment,
} from './start-rpc-fixtures';

const Init = z.object({
  method: z.string(),
  headers: z.instanceof(Headers),
  body: z.string().optional(),
  signal: z.instanceof(AbortSignal).optional(),
});
const Transport = z.object({
  serverFnFetcher: z.function({
    input: z.tuple([
      z.string(),
      z.array(z.unknown()),
      z.function({
        input: z.tuple([z.string(), z.unknown()]),
        output: z.promise(z.instanceof(Response)),
      }),
    ]),
    output: z.promise(z.unknown()),
  }),
});
const Envelope = z.object({ result: z.unknown(), error: z.unknown().optional() });
const ContextRunner = z.object({
  runWithStartContext: z.function({
    input: z.tuple([z.unknown(), z.function({ input: z.tuple([]), output: z.unknown() })]),
    output: z.promise(z.unknown()),
  }),
});

async function client() {
  const entry = await realpath(
    fileURLToPath(import.meta.resolve('@tanstack/react-start/client-rpc')),
  );
  const core = createRequire(entry).resolve('@tanstack/start-client-core/package.json');
  const module: unknown = await import(
    pathToFileURL(join(dirname(core), 'dist/esm/client-rpc/serverFnFetcher.js')).href
  );
  const fetcher = Transport.parse(module).serverFnFetcher;
  const storagePackage = createRequire(core).resolve(
    '@tanstack/start-storage-context/package.json',
  );
  const storage: unknown = await import(
    pathToFileURL(join(dirname(storagePackage), 'dist/esm/index.js')).href
  );
  const { runWithStartContext } = ContextRunner.parse(storage);
  // Node selects the framework's server-side getStartOptions. Supply its normal ALS scope,
  // with no router/server execution, so the installed client serializer can read empty options.
  return (...args: Parameters<typeof fetcher>) =>
    runWithStartContext(
      {
        startOptions: {},
        request: new Request('http://fixture.test'),
        handlerType: 'serverFn',
        contextAfterGlobalMiddlewares: {},
        executedRequestMiddlewares: new Set(),
        getRouter: () => {
          throw new Error('Transport unit must not load a router');
        },
      },
      () => fetcher(...args),
    );
}

test('emitted map and real client transport retain nested scenario resources, decisions and retraction', async () => {
  const map = await loadBuiltFunctionMap();
  const fetcher = await client();
  const scenario = createApiFixtureScenario('inbox-auto-applied');
  const wire: Array<{ method: string; name: string; status: number }> = [];
  async function invoke(name: string, data?: unknown) {
    const id = [...map].find(([, value]) => value === name)?.[0];
    assert(id);
    const handler = async (url: string, init: unknown) => {
      const options = Init.parse(init);
      const decoded = await decodeRpcRequest(
        {
          url: () => url,
          method: () => options.method,
          headers: () => Object.fromEntries(options.headers),
          postData: () => options.body ?? null,
          postDataJSON: () => (options.body ? JSON.parse(options.body) : null),
        },
        map,
      );
      let response = new Response(null, { status: 599 });
      await scenario.handleRequest({
        request: () => decoded.request,
        fallback: async () => {
          throw new Error('Unexpected fixture fallback');
        },
        fulfill: async (value) => {
          const fulfilled = await rpcFulfillment(decoded.name, value);
          assert.equal(typeof fulfilled.body, 'string');
          if (typeof fulfilled.body !== 'string') throw new Error('Expected serialized body');
          response = new Response(fulfilled.body, {
            status: fulfilled.status,
            headers: {
              ...fulfilled.headers,
              'content-type': fulfilled.contentType ?? 'application/json',
            },
          });
          wire.push({ method: options.method, name: decoded.name, status: response.status });
        },
      });
      return response;
    };
    return fetcher(
      `http://fixture.test/_serverFn/${id}`,
      [{ method: name === 'decideStartProposal' ? 'POST' : 'GET', data, fetch: handler }],
      handler,
    );
  }
  const page = Envelope.parse(
    await invoke('getStartProposalInbox', {
      lane: 'decision',
      status: 'pending',
      limit: '500',
      cursor: undefined,
    }),
  );
  assert.equal(typeof page.result, 'string');
  const proposals = ProposalPageResponseSchema.parse(JSON.parse(z.string().parse(page.result)));
  assert.equal(proposals.page.limit, 500);
  assert.equal(proposals.rows[0]?.id, 'proposal-learning-plan-1');
  assert.equal(proposals.rows[0]?.payload.kind, 'learning_item');
  assert.deepEqual(proposals.data, proposals.rows);
  assert.match(proposals.rows[0]?.presentation?.technical_details ?? '', /knowledge_node/);
  const accepted = ProposalDecisionResource.parse(
    JSON.parse(
      z.string().parse(
        Envelope.parse(
          await invoke('decideStartProposal', {
            id: 'proposal-learning-plan-1',
            input: { decision: 'accept' },
          }),
        ).result,
      ),
    ),
  );
  assert.equal(accepted.created, true);
  assert.equal(accepted.idempotent, false);
  assert.equal(accepted.decision_event_id, 'event-decision-1');
  assert.equal(z.object({ kind: z.string() }).parse(accepted.result).kind, 'learning_item');
  const retracted = ProposalDecisionResource.parse(
    JSON.parse(
      z.string().parse(
        Envelope.parse(
          await invoke('decideStartProposal', {
            id: 'proposal-completion-1',
            input: { decision: 'retract' },
          }),
        ).result,
      ),
    ),
  );
  assert.equal(retracted.decision_event_id, 'event-retract-1');
  const digest = z
    .object({ rows: z.array(z.object({ reverted: z.boolean() })) })
    .parse(Envelope.parse(await invoke('getStartAutoApplied')).result);
  assert.equal(digest.rows[0]?.reverted, true);
  assert.deepEqual(scenario.proposalDecisions(), [
    { id: 'proposal-learning-plan-1', decision: 'accept' },
    { id: 'proposal-completion-1', decision: 'retract' },
  ]);
  assert.deepEqual(scenario.unexpectedRequests, []);
  assert(wire.every((r) => r.status === 200));
});

test('decoded GET query preserves opaque cursor and unknown operations/methods fail closed', async () => {
  const map = await loadBuiltFunctionMap();
  const id = [...map].find(([, name]) => name === 'getStartProposalInbox')?.[0];
  assert(id);
  const fetcher = await client();
  const data = { lane: 'observation', status: 'pending', limit: '200', cursor: 'opaque:+/=?多层' };
  await fetcher(
    `http://fixture.test/_serverFn/${id}`,
    [
      {
        method: 'GET',
        data,
        fetch: async (url: string, init: RequestInit) => {
          const options = Init.parse(init);
          const request = {
            url: () => url,
            method: () => options.method,
            headers: () => Object.fromEntries(options.headers),
            postData: () => null,
            postDataJSON: () => null,
          };
          const decoded = await decodeRpcRequest(request, map);
          assert.deepEqual(Object.fromEntries(new URL(decoded.request.url()).searchParams), data);
          assert.equal(options.headers.get('x-tsr-serverFn'), 'true');
          await assert.rejects(
            decodeRpcRequest({ ...request, method: () => 'POST' }, map),
            /method\/header/,
          );
          await assert.rejects(
            decodeRpcRequest(
              { ...request, url: () => `http://fixture.test/_serverFn/${'f'.repeat(64)}` },
              map,
            ),
            /Unknown/,
          );
          const fulfilled = await rpcFulfillment(decoded.name, {
            json: {
              rows: [],
              next_cursor: null,
              data: [],
              page: { limit: 200, next_cursor: null },
            },
          });
          return new Response(z.string().parse(fulfilled.body), {
            headers: { ...fulfilled.headers, 'content-type': 'application/json' },
          });
        },
      },
    ],
    async () => {
      throw new Error('Network fallback prohibited');
    },
  );
});

test('failure/loading override patterns match decoded Start reads and preserve raw 401/503', async () => {
  assert(matchesFixturePattern('**/api/cost/today', new URL('http://fixture.test/api/cost/today')));
  assert(
    matchesFixturePattern(
      '**/api/admin/cost**',
      new URL('http://fixture.test/api/admin/cost?days=30'),
    ),
  );
  assert(
    !matchesFixturePattern('**/api/admin/config', new URL('http://fixture.test/api/cost/today')),
  );
  assert.throws(
    () => matchesFixturePattern('**/unmapped/**', new URL('http://fixture.test/api/cost/today')),
    /Unsupported/,
  );
  for (const status of [401, 503]) {
    const response = await rpcFulfillment('getStartTodayCost', {
      status,
      json: { error: 'cost_read_unavailable', message: 'not zero' },
    });
    assert.equal(response.status, status);
    assert.equal(response.headers?.['x-tss-raw'], 'true');
    assert.equal(response.headers?.['x-tss-serialized'], undefined);
    assert.deepEqual(response.json, { error: 'cost_read_unavailable', message: 'not zero' });
  }
});

test('all stateful brief calls still pass through the canonical scenario handlers', async () => {
  const scenario = createApiFixtureScenario('teaching-brief');
  const responses: unknown[] = [];
  const call = async (path: string, body: unknown, method = 'POST') =>
    scenario.handleRequest({
      request: () => ({
        url: () => `http://fixture.test${path}`,
        method: () => method,
        headers: () => ({}),
        postData: () => JSON.stringify(body),
        postDataJSON: () => body,
      }),
      fulfill: async (options = {}) => {
        responses.push(typeof options.body === 'string' ? JSON.parse(options.body) : options.json);
      },
      fallback: async () => {
        throw new Error('Unexpected fallback');
      },
    });
  await call('/api/prep-desk/brief/interaction', {
    type: 'brief_seen',
    brief_id: 'evt_conjecture_wy1',
    brief_state: 'finding',
  });
  await call('/api/proposals/evt_conjecture_wy1/decisions', { decision: 'accept' });
  await call('/api/prep-desk/brief', undefined, 'GET');
  assert.deepEqual(scenario.briefInteractions(), [
    { type: 'brief_seen', brief_id: 'evt_conjecture_wy1', brief_state: 'finding' },
  ]);
  assert(scenario.briefCalls().includes('POST /api/proposals/evt_conjecture_wy1/decisions'));
  assert.equal(
    z.object({ brief: z.object({ state: z.string() }) }).parse(responses[2]).brief.state,
    'probe_ready',
  );
  await call('/api/proposals', undefined, 'GET');
  assert.deepEqual(scenario.unexpectedRequests, ['GET /api/proposals']);
});

test('Start document manifest, fallback SPA and served bytes keep distinct provenance', async () => {
  const manifest = await readStartAssetManifest();
  const start = startRouteAssets(manifest);
  const html = start
    .map((path) => `<${path.endsWith('.css') ? 'link href' : 'script src'}="${path}">`)
    .join('');
  assert.deepEqual(documentAssets(html, '/_build/assets/'), start);
  const spa = documentAssets(await readFile('web/dist/index.html', 'utf8'), '/assets/');
  assert(spa.length > 1);
  assert(spa.every((path) => path.startsWith('/assets/')));
  assert.throws(
    () => documentAssets('<script src="/src/main.tsx"></script>', '/_build/assets/'),
    /Development/,
  );
  assert.throws(
    () =>
      documentAssets(
        '<script src="/_build/assets/index.js"></script><link href="/_build/assets/main.css">',
        '/_build/assets/',
      ),
    /unhashed/,
  );
  const bytes = new TextEncoder().encode('real built bytes \0 长文本');
  await verifyServedAsset(
    'http://fixture.test',
    start[0] ?? '',
    bytes,
    async () => new Response(bytes),
  );
  await assert.rejects(
    verifyServedAsset(
      'http://fixture.test',
      start[0] ?? '',
      bytes,
      async () => new Response('stale bytes'),
    ),
    /expected_sha256/,
  );
  await assert.rejects(
    verifyServedAsset(
      'http://fixture.test',
      start[0] ?? '',
      bytes,
      async () => new Response('unavailable', { status: 503 }),
    ),
    /actual=503/,
  );
});

test('missing or duplicate emitted RPC functions cannot silently select stale fixture IDs', async () => {
  const map = await loadBuiltFunctionMap();
  const text = [...map]
    .map(([id, name]) => `"${id}": { functionName: "${name}_createServerFn_handler" }`)
    .join('\n');
  assert.equal(parseBuiltFunctionMap(text).size, map.size);
  assert.throws(
    () =>
      parseBuiltFunctionMap(
        text.replace(
          'getStartTodayCost_createServerFn_handler',
          'unexpected_createServerFn_handler',
        ),
      ),
    /missing getStartTodayCost/,
  );
  assert.throws(() => parseBuiltFunctionMap(`${text}\n${text}`), /Duplicate/);
});

test('retained HTTP201/Location and serialized RPC200 preserve the same immutable resource', async () => {
  const resource = {
    proposal_id: 'decision-resource',
    proposal_kind: 'learning_item',
    decision: 'dismiss',
    decision_event_id: 'immutable-rate',
    proposal_status: 'dismissed',
    created: true,
    idempotent: false,
    result: { kind: 'dismissed', rate_event_id: 'immutable-rate' },
  };
  const http = {
    url: () => 'http://fixture.test/api/proposals/decision-resource/decisions',
    status: () => 201,
    headers: () => ({ location: '/api/events/immutable-rate' }),
    json: async () => resource,
  };
  assert.deepEqual(await readProposalDecisionResponse(http), resource);
  await assert.rejects(readProposalDecisionResponse({ ...http, status: () => 200 }), /HTTP201/);
  await assert.rejects(
    readProposalDecisionResponse({
      ...http,
      headers: () => ({ location: '/api/events/different' }),
    }),
    /Location/,
  );
  const fulfilled = await rpcFulfillment('decideStartProposal', {
    status: 201,
    json: resource,
    headers: { Location: '/api/events/immutable-rate' },
  });
  assert.equal(fulfilled.status, 200);
  assert.equal(fulfilled.headers?.Location, undefined);
  const rpc = {
    url: () => `http://fixture.test/_serverFn/${'a'.repeat(64)}`,
    status: () => 200,
    headers: () => ({ 'x-tss-serialized': 'true' }),
    json: async () => JSON.parse(z.string().parse(fulfilled.body)),
  };
  assert.deepEqual(await readProposalDecisionResponse(rpc), resource);
  await assert.rejects(readProposalDecisionResponse({ ...rpc, status: () => 201 }), /RPC200/);
});

test('six admin reads use the installed RPC serializer with complete ISO/nullable DTOs', async () => {
  const map = await loadBuiltFunctionMap();
  const fetcher = await client();
  const cases = [
    {
      name: 'getStartAdminRuns',
      data: { limit: '100', status: 'failure', cursor: 'opaque:+/=?多层' },
      path: '/api/admin/runs',
      fixture: adminRuns,
      schema: AdminRunsResponseSchema,
    },
    {
      name: 'getStartAdminRunDetail',
      data: { id: 'run id/多层' },
      path: '/api/admin/runs/run%20id%2F%E5%A4%9A%E5%B1%82',
      fixture: adminDetail,
      schema: AdminRunDetailResponseSchema,
    },
    {
      name: 'getStartAdminCost',
      data: { days: '30' },
      path: '/api/admin/cost',
      fixture: adminCost,
      schema: AdminCostResponseSchema,
    },
    {
      name: 'getStartAdminFailures',
      data: { limit: '200' },
      path: '/api/admin/failures',
      fixture: adminFailures,
      schema: AdminFailuresResponseSchema,
    },
    {
      name: 'getStartAdminCoverage',
      data: undefined,
      path: '/api/admin/coverage-lattice',
      fixture: adminCoverage,
      schema: CoverageLatticeResponseSchema,
    },
    {
      name: 'getStartAdminConjectureScores',
      data: undefined,
      path: '/api/admin/conjecture-scores',
      fixture: adminConjectures,
      schema: ConjectureScoresResponseSchema,
    },
  ];
  for (const entry of cases) {
    const id = [...map].find(([, value]) => value === entry.name)?.[0];
    assert(id);
    const transport = async (url: string, init: unknown) => {
      const options = Init.parse(init);
      const decoded = await decodeRpcRequest(
        {
          url: () => url,
          method: () => options.method,
          headers: () => Object.fromEntries(options.headers),
          postData: () => null,
          postDataJSON: () => null,
        },
        map,
      );
      const fixtureUrl = new URL(decoded.request.url());
      assert.equal(fixtureUrl.pathname, entry.path);
      if (entry.data && !('id' in entry.data))
        assert.deepEqual(Object.fromEntries(fixtureUrl.searchParams), entry.data);
      const result = await rpcFulfillment(decoded.name, { json: entry.fixture });
      return new Response(z.string().parse(result.body), {
        status: result.status,
        headers: { ...result.headers, 'content-type': 'application/json' },
      });
    };
    const envelope = Envelope.parse(
      await fetcher(
        `http://fixture.test/_serverFn/${id}`,
        [{ method: 'GET', data: entry.data, fetch: transport }],
        transport,
      ),
    );
    assert.equal(envelope.error, undefined);
    entry.schema.parse(envelope.result);
    assert.deepEqual(envelope.result, entry.fixture);
  }
});
