import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type ApiRouteDecl,
  type CapabilityManifest,
  assertApiRouteSuccessStatus,
  defineCapability,
  validateComposition,
} from './manifest';

const base = (over: Partial<CapabilityManifest> & { name: string }): CapabilityManifest =>
  defineCapability({ description: 'test capability', ...over });

describe('validateComposition', () => {
  it('accepts unique names, actions, routes, jobs and proposal kinds', () => {
    expect(() =>
      validateComposition([
        base({
          name: 'a',
          events: { actions: ['experimental:x'] },
          api: { routes: [{ method: 'GET', path: '/api/a' }] },
          jobs: { handlers: [{ name: 'job_a', queue: 'fast' }] },
          proposals: { kinds: [{ kind: 'kind_a' }] },
        }),
        base({
          name: 'b',
          events: { actions: ['experimental:y'] },
          api: { routes: [{ method: 'GET', path: '/api/b' }] },
          jobs: {
            handlers: [
              {
                name: 'job_b',
                queue: 'llm',
                schedule: { cron: '15 3 * * *', tz: 'Asia/Shanghai' },
              },
            ],
          },
          proposals: { kinds: [{ kind: 'kind_b' }] },
        }),
      ]),
    ).not.toThrow();
  });

  it('rejects duplicate capability names', () => {
    expect(() => validateComposition([base({ name: 'a' }), base({ name: 'a' })])).toThrow(
      /duplicate capability name/,
    );
  });

  it('rejects one event action declared by two capabilities', () => {
    expect(() =>
      validateComposition([
        base({ name: 'a', events: { actions: ['experimental:x'] } }),
        base({ name: 'b', events: { actions: ['experimental:x'] } }),
      ]),
    ).toThrow(/declared by both 'a' and 'b'/);
  });

  it('accepts a versioned subscription owned by a different capability than its event', () => {
    let loaded = false;
    expect(() =>
      validateComposition([
        base({
          name: 'subscriber',
          subscriptions: {
            handlers: [
              {
                id: 'subscriber.x',
                version: 1,
                actions: ['experimental:x'],
                load: async () => {
                  loaded = true;
                  return () => async () => ({ status: 'succeeded' });
                },
              },
            ],
          },
        }),
        base({ name: 'owner', events: { actions: ['experimental:x'] } }),
      ]),
    ).not.toThrow();
    expect(loaded).toBe(false);
  });

  it('allows separate versions but rejects duplicate subscription id/version pairs', () => {
    const load = async () => () => async () => ({ status: 'succeeded' as const });
    expect(() =>
      validateComposition([
        base({ name: 'owner', events: { actions: ['experimental:x'] } }),
        base({
          name: 'a',
          subscriptions: {
            handlers: [
              { id: 'subscriber.x', version: 1, actions: ['experimental:x'], load },
              { id: 'subscriber.x', version: 2, actions: ['experimental:x'], load },
            ],
          },
        }),
      ]),
    ).not.toThrow();

    expect(() =>
      validateComposition([
        base({ name: 'owner', events: { actions: ['experimental:x'] } }),
        base({
          name: 'a',
          subscriptions: {
            handlers: [{ id: 'subscriber.x', version: 1, actions: ['experimental:x'], load }],
          },
        }),
        base({
          name: 'b',
          subscriptions: {
            handlers: [{ id: 'subscriber.x', version: 1, actions: ['experimental:x'], load }],
          },
        }),
      ]),
    ).toThrow(/duplicate event subscription 'subscriber\.x@v1'.*'a'.*'b'/);
  });

  it.each([
    { id: '', version: 1, error: /invalid id/ },
    { id: '   ', version: 1, error: /invalid id/ },
    { id: 'subscriber.x', version: 0, error: /invalid version 0/ },
    { id: 'subscriber.x', version: -1, error: /invalid version -1/ },
    { id: 'subscriber.x', version: 1.5, error: /invalid version 1\.5/ },
  ])('rejects invalid subscription identity $id@$version', ({ id, version, error }) => {
    expect(() =>
      validateComposition([
        base({ name: 'owner', events: { actions: ['experimental:x'] } }),
        base({
          name: 'subscriber',
          subscriptions: {
            handlers: [
              {
                id,
                version,
                actions: ['experimental:x'],
                load: async () => () => async () => ({ status: 'succeeded' }),
              },
            ],
          },
        }),
      ]),
    ).toThrow(error);
  });

  it('rejects empty, duplicate, and undeclared subscription actions', () => {
    const subscription = {
      id: 'subscriber.x',
      version: 1,
      load: async () => () => async () => ({ status: 'succeeded' as const }),
    };
    const manifest = (actions: string[]) => [
      base({ name: 'owner', events: { actions: ['experimental:x'] } }),
      base({
        name: 'subscriber',
        subscriptions: { handlers: [{ ...subscription, actions }] },
      }),
    ];

    expect(() => validateComposition(manifest([]))).toThrow(/must declare at least one action/);
    expect(() => validateComposition(manifest(['']))).toThrow(/declares an empty action/);
    expect(() => validateComposition(manifest(['   ']))).toThrow(/declares an empty action/);
    expect(() => validateComposition(manifest(['experimental:x', 'experimental:x']))).toThrow(
      /duplicate action 'experimental:x'/,
    );
    expect(() => validateComposition(manifest(['experimental:unknown']))).toThrow(
      /undeclared event action 'experimental:unknown'/,
    );
  });

  it('rejects a subscription without a callable loader at runtime', () => {
    expect(() =>
      validateComposition([
        base({ name: 'owner', events: { actions: ['experimental:x'] } }),
        base({
          name: 'subscriber',
          subscriptions: {
            handlers: [
              {
                id: 'subscriber.x',
                version: 1,
                actions: ['experimental:x'],
                load: undefined,
              } as never,
            ],
          },
        }),
      ]),
    ).toThrow(/has no loader/);
  });

  it('accepts a route declaration carrying a lazy handler ref', () => {
    expect(() =>
      validateComposition([
        base({
          name: 'a',
          api: {
            routes: [
              {
                method: 'GET',
                path: '/api/a',
                load: async () => async () => Response.json({ ok: true }),
              },
            ],
          },
        }),
      ]),
    ).not.toThrow();
  });

  it('rejects one method+path declared by two capabilities', () => {
    expect(() =>
      validateComposition([
        base({ name: 'a', api: { routes: [{ method: 'GET', path: '/api/x' }] } }),
        base({ name: 'b', api: { routes: [{ method: 'GET', path: '/api/x' }] } }),
      ]),
    ).toThrow(/declared by both 'a' and 'b'/);
  });

  it('rejects manifest routes that shadow built-in API routes', () => {
    expect(() =>
      validateComposition([
        base({
          name: 'a',
          api: { routes: [{ method: 'GET', path: '/api/openapi.json' }] },
        }),
      ]),
    ).toThrow(/declared by both 'builtin' and 'a'/);
  });

  it('rejects duplicate operationIds across otherwise unique routes', () => {
    const response = z.object({ ok: z.boolean() });
    expect(() =>
      validateComposition([
        base({
          name: 'a',
          api: {
            routes: [
              {
                method: 'GET',
                path: '/api/a',
                operationId: 'getShared',
                successStatus: 200,
                responses: { 200: response },
              },
            ],
          },
        }),
        base({
          name: 'b',
          api: {
            routes: [
              {
                method: 'GET',
                path: '/api/b',
                operationId: 'getShared',
                successStatus: 200,
                responses: { 200: response },
              },
            ],
          },
        }),
      ]),
    ).toThrow(/operationId 'getShared'.*GET \/api\/a.*GET \/api\/b/);
  });

  it('rejects invalid and built-in operationIds', () => {
    const route = (operationId: string) =>
      base({
        name: operationId,
        api: {
          routes: [
            {
              method: 'GET',
              path: `/api/${operationId}`,
              operationId,
              successStatus: 200,
              responses: { 200: z.unknown() },
            },
          ],
        },
      });
    expect(() => validateComposition([route('bad-operation')])).toThrow(/invalid operationId/);
    expect(() => validateComposition([route('getHealth')])).toThrow(/GET \/api\/health/);
  });

  it('requires operation path params and request.params schema to match exactly', () => {
    expect(() =>
      validateComposition([
        base({
          name: 'a',
          api: {
            routes: [
              {
                method: 'GET',
                path: '/api/a/[id]',
                operationId: 'getA',
                request: { params: z.object({ wrong: z.string() }) },
                successStatus: 200,
                responses: { 200: z.object({ id: z.string() }) },
              },
            ],
          },
        }),
      ]),
    ).toThrow(/path params \[id\].*request.params \[wrong\]/);
  });

  it('requires every declared success status to have a response schema', () => {
    expect(() =>
      validateComposition([
        base({
          name: 'a',
          api: {
            routes: [
              {
                method: 'POST',
                path: '/api/a',
                operationId: 'createA',
                successStatus: [200, 201],
                responses: { 201: z.object({ id: z.string() }) },
              },
            ],
          },
        }),
      ]),
    ).toThrow(/success status 200 has no response schema/);
  });

  it('accepts per-status response media types and rejects invalid declarations', () => {
    const route = (responseMediaTypes: Record<number, string>) =>
      base({
        name: 'a',
        api: {
          routes: [
            {
              method: 'POST',
              path: '/api/a',
              operationId: 'createA',
              successStatus: [200, 202],
              responses: { 200: z.string(), 202: z.object({ id: z.string() }) },
              responseMediaTypes,
            },
          ],
        },
      });

    expect(() =>
      validateComposition([route({ 200: 'text/event-stream', 202: 'application/json' })]),
    ).not.toThrow();
    expect(() => validateComposition([route({ 200: 'not-a-media-type' })])).toThrow(
      /invalid response media type/,
    );
    expect(() => validateComposition([route({ 201: 'application/json' })])).toThrow(
      /status 201 has no response schema/,
    );
  });

  it('accepts request body media types and optional bodies, and validates their declarations', () => {
    const route = (request: ApiRouteDecl['request']) =>
      base({
        name: 'a',
        api: {
          routes: [
            {
              method: 'POST',
              path: '/api/a',
              operationId: 'createA',
              request,
              successStatus: 200,
              responses: { 200: z.object({ ok: z.boolean() }) },
            },
          ],
        },
      });

    expect(() =>
      validateComposition([
        route({
          body: z.object({ file: z.string() }),
          bodyMediaType: 'multipart/form-data',
          bodyRequired: false,
        }),
      ]),
    ).not.toThrow();
    expect(() => validateComposition([route({ bodyMediaType: 'multipart/form-data' })])).toThrow(
      /no body schema/,
    );
    expect(() =>
      validateComposition([route({ body: z.string(), bodyMediaType: 'not-a-media-type' })]),
    ).toThrow(/invalid request body media type/);
    expect(() => validateComposition([route({ bodyRequired: false })])).toThrow(/no body schema/);
  });

  it('requires request header declarations to use a Zod object', () => {
    expect(() =>
      validateComposition([
        base({
          name: 'a',
          api: {
            routes: [
              {
                method: 'GET',
                path: '/api/a',
                operationId: 'getA',
                request: { headers: z.string() },
                successStatus: 200,
                responses: { 200: z.string() },
              },
            ],
          },
        }),
      ]),
    ).toThrow(/request.headers must be a Zod object/);
  });

  it('rejects invalid cursor pagination declarations', () => {
    expect(() =>
      validateComposition([
        base({
          name: 'a',
          api: {
            routes: [
              {
                method: 'GET',
                path: '/api/a',
                pagination: { kind: 'cursor', defaultLimit: 100, maxLimit: 50 },
              },
            ],
          },
        }),
      ]),
    ).toThrow(/invalid cursor pagination limits/);
  });

  it('requires cursor pagination query fields in the request schema', () => {
    expect(() =>
      validateComposition([
        base({
          name: 'a',
          api: {
            routes: [
              {
                method: 'GET',
                path: '/api/a',
                request: { query: z.object({ limit: z.number().optional() }) },
                pagination: { kind: 'cursor', defaultLimit: 20, maxLimit: 100 },
              },
            ],
          },
        }),
      ]),
    ).toThrow(/requires request.query cursor and limit/);
  });

  it('accepts refined cursor query schemas while checking their object fields', () => {
    expect(() =>
      validateComposition([
        base({
          name: 'a',
          api: {
            routes: [
              {
                method: 'GET',
                path: '/api/a',
                request: {
                  query: z
                    .object({
                      cursor: z.string().optional(),
                      limit: z.coerce.number().int().positive().optional(),
                      mode: z.string().optional(),
                    })
                    .refine((query) => !(query.cursor && query.mode === 'all')),
                },
                pagination: { kind: 'cursor', defaultLimit: 20, maxLimit: 100 },
              },
            ],
          },
        }),
      ]),
    ).not.toThrow();
  });

  it('checks successful handler responses against the declared status set', () => {
    const route = {
      method: 'POST' as const,
      path: '/api/a',
      successStatus: [200, 201],
      responses: { 200: z.unknown(), 201: z.unknown() },
    };
    expect(() =>
      assertApiRouteSuccessStatus(route, Response.json({}, { status: 201 })),
    ).not.toThrow();
    expect(() => assertApiRouteSuccessStatus(route, Response.json({}, { status: 202 }))).toThrow(
      /returned 202.*200\/201/,
    );
    expect(() =>
      assertApiRouteSuccessStatus(route, Response.json({}, { status: 409 })),
    ).not.toThrow();
  });

  it('rejects one job name declared by two capabilities', () => {
    expect(() =>
      validateComposition([
        base({ name: 'a', jobs: { handlers: [{ name: 'dreaming_nightly', queue: 'agent' }] } }),
        base({ name: 'b', jobs: { handlers: [{ name: 'dreaming_nightly', queue: 'llm' }] } }),
      ]),
    ).toThrow(/job 'dreaming_nightly' declared by both 'a' and 'b'/);
  });

  it('rejects one proposal kind declared by two capabilities', () => {
    expect(() =>
      validateComposition([
        base({ name: 'a', proposals: { kinds: [{ kind: 'learning_item' }] } }),
        base({ name: 'b', proposals: { kinds: [{ kind: 'learning_item' }] } }),
      ]),
    ).toThrow(/proposal kind 'learning_item' declared by both 'a' and 'b'/);
  });

  it('copilotTools 工具名跨包重复 → throw', () => {
    const a: CapabilityManifest = {
      name: 'a',
      description: 'a',
      copilotTools: { tools: [{ name: 'query_events' }] },
    };
    const b: CapabilityManifest = {
      name: 'b',
      description: 'b',
      copilotTools: { tools: [{ name: 'query_events' }] },
    };
    expect(() => validateComposition([a, b])).toThrow(
      /copilot tool 'query_events' declared by both 'a' and 'b'/,
    );
  });

  it('copilotTools 工具名唯一时通过', () => {
    const a: CapabilityManifest = {
      name: 'a',
      description: 'a',
      copilotTools: { tools: [{ name: 'query_events' }] },
    };
    const b: CapabilityManifest = {
      name: 'b',
      description: 'b',
      copilotTools: { tools: [{ name: 'query_mistakes' }] },
    };
    expect(() => validateComposition([a, b])).not.toThrow();
  });

  it('未声明 copilotTools 的包不参与第 6 循环', () => {
    const a: CapabilityManifest = { name: 'a', description: 'a' };
    expect(() => validateComposition([a])).not.toThrow();
  });

  it('rejects one UI page declared by two capabilities', () => {
    expect(() =>
      validateComposition([
        base({ name: 'a', ui: { pages: [{ route: '/shared' }] } }),
        base({ name: 'b', ui: { pages: [{ route: '/shared' }] } }),
      ]),
    ).toThrow(/ui page '\/shared' declared by both 'a' and 'b'/);
  });
});
