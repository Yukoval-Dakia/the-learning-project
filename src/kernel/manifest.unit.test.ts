import { describe, expect, it } from 'vitest';
import { type CapabilityManifest, defineCapability, validateComposition } from './manifest';

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
    expect(() => validateComposition([a, b])).toThrow(/query_events.*declared by both/);
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
});
