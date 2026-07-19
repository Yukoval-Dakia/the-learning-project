import { describe, expect, it, vi } from 'vitest';
import { readMemoryFacts } from './read';

describe('readMemoryFacts', () => {
  it('constructs one client lazily and routes reads through the canonical search policy', async () => {
    const search = vi.fn(async () => ({
      results: [{ id: 'm1', memory: 'prefers concise explanations', score: 0.8 }],
    }));
    const createClient = vi.fn(() => ({ search }));

    const result = await readMemoryFacts('learner preferences', { topK: 2 }, { createClient });

    expect(createClient).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith('learner preferences', {
      topK: 6,
      filters: { NOT: [{ superseded_by: '*' }] },
    });
    expect(result.results?.map((item) => item.id)).toEqual(['m1']);
  });
});
