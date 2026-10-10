import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// YUK-471 W1 PR-A2b — prove the parity asserts ROUTE a gather/reducer throw through the
// dev-throws / prod-logs switch (onParityMismatch) instead of letting it propagate raw. In
// prod a propagated throw would roll back a successful live accept (contract violation); in
// dev/test the switch RETHROWS, so the throw must surface as a `<fold-threw>` parity error,
// NOT as the original bare error escaping the assert. We mock the gather layer to force the
// throw deterministically (the node reducer is throw-free with real data, so a real-data test
// can't reach this defensive path — hence the mock).
vi.mock('./gather', () => ({
  gatherAndFoldKnowledgeNode: vi.fn(async () => {
    throw new TypeError('boom-node');
  }),
  gatherAndFoldKnowledgeEdge: vi.fn(async () => {
    throw new TypeError('boom-edge');
  }),
}));

import { gatherAndFoldKnowledgeNode } from './gather';
import { assertKnowledgeNodeParity } from './parity';

const fakeDb = {} as never;

// SCF-210 / YUK-1271 — the PROD warn's `diff_fields` must keep a sentinel's tag intact (and never
// leak a user value). onParityMismatch is module-private, so drive it through the public assert
// with NODE_ENV=production (the prod warn+return branch) and the mocked gather.
describe('onParityMismatch PROD diff_fields — sentinel tags + value-free field names', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    warnSpy.mockRestore();
  });

  function diffFields(call: number): string[] {
    const meta = warnSpy.mock.calls[call]?.[1];
    if (!meta) throw new Error(`no console.warn metadata at call ${call}`);
    return (meta as { diff_fields: string[] }).diff_fields;
  }

  it('logs only the field NAME — never the user value', async () => {
    vi.mocked(gatherAndFoldKnowledgeNode).mockResolvedValueOnce({
      id: 'n1',
      name: 'SECRET-FOLDED',
    } as never);
    await expect(
      assertKnowledgeNodeParity(fakeDb, 'n1', { id: 'n1', name: 'SECRET-LIVE' } as never),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(diffFields(0)).toEqual(['name']);
    expect(JSON.stringify(warnSpy.mock.calls[0]?.[1])).not.toContain('SECRET');
  });
});
