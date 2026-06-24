import { describe, expect, it, vi } from 'vitest';

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

import { assertKnowledgeEdgeParity, assertKnowledgeNodeParity } from './parity';

const fakeDb = {} as never;

describe('parity assert — gather/reducer throw routing (dev/test rethrow)', () => {
  it('node assert routes a gather throw through onParityMismatch (<fold-threw>)', async () => {
    await expect(assertKnowledgeNodeParity(fakeDb, 'n1', null)).rejects.toThrow(/fold-threw/i);
  });

  it('node assert preserves the original throw message', async () => {
    await expect(assertKnowledgeNodeParity(fakeDb, 'n1', null)).rejects.toThrow(/boom-node/);
  });

  it('edge assert routes a gather throw through onParityMismatch (<fold-threw>)', async () => {
    await expect(assertKnowledgeEdgeParity(fakeDb, 'e1', null)).rejects.toThrow(/fold-threw/i);
  });
});
