import { describe, expect, it, vi } from 'vitest';
import { createMem0OpaqueOperationContext } from '../ai/provider-attempt-runtime';
import { readMemoryFacts } from './read';

describe('readMemoryFacts', () => {
  it('constructs one client lazily and routes reads through the canonical search policy', async () => {
    const search = vi.fn(async () => ({
      results: [{ id: 'm1', memory: 'prefers concise explanations', score: 0.8 }],
    }));
    const createClient = vi.fn(() => ({ search }));

    const providerOperation = createMem0OpaqueOperationContext({
      caller: 'api',
      deadlineAt: new Date('2026-08-09T03:01:00.000Z'),
      operationAnchor: 'read-memory-facts-unit-852',
      mode: 'observe',
      createLifecycle: vi.fn(),
    });
    const result = await readMemoryFacts('learner preferences', { topK: 2 }, providerOperation, {
      createClient,
    });

    expect(createClient).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith(
      'learner preferences',
      {
        topK: 6,
        filters: { NOT: [{ superseded_by: '*' }] },
      },
      providerOperation,
    );
    expect(result.results?.map((item) => item.id)).toEqual(['m1']);
  });
});
