import { describe, expect, it } from 'vitest';
import { type CapabilityManifest, defineCapability, validateComposition } from './manifest';

const base = (over: Partial<CapabilityManifest> & { name: string }): CapabilityManifest =>
  defineCapability({ description: 'test capability', ...over });

describe('validateComposition', () => {
  it('accepts unique names, actions and routes', () => {
    expect(() =>
      validateComposition([
        base({
          name: 'a',
          events: { actions: ['experimental:x'] },
          api: { routes: [{ method: 'GET', path: '/api/a' }] },
        }),
        base({
          name: 'b',
          events: { actions: ['experimental:y'] },
          api: { routes: [{ method: 'GET', path: '/api/b' }] },
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

  it('rejects one method+path declared by two capabilities', () => {
    expect(() =>
      validateComposition([
        base({ name: 'a', api: { routes: [{ method: 'GET', path: '/api/x' }] } }),
        base({ name: 'b', api: { routes: [{ method: 'GET', path: '/api/x' }] } }),
      ]),
    ).toThrow(/declared by both 'a' and 'b'/);
  });
});
