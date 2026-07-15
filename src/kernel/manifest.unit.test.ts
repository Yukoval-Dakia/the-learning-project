import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
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
