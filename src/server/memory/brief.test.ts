import { describe, expect, it, vi } from 'vitest';
import { BRIEF_TEMPLATES, regenerateMemoryBrief } from './brief';

describe('BRIEF_TEMPLATES', () => {
  it('defines one template for each ADR-0017 scope prefix', () => {
    expect(Object.keys(BRIEF_TEMPLATES).sort()).toEqual([
      'global',
      'meta:orchestrator_self',
      'mistake_cluster',
      'subject',
      'topic',
    ]);
  });
});

describe('regenerateMemoryBrief', () => {
  it('builds a scoped prompt, calls injected LLM once, and upserts one brief row', async () => {
    const generate = vi.fn(async () => ({
      recent_week_md: '## Recent week\n- Still misses punctuation particles.',
      recent_months_md: '## Recent months\n- Improving on function words.',
      long_term_md: '## Long term\n- Responds well to contrastive examples.',
      recent_week_evidence_ids: ['evt_1'],
      recent_months_evidence_ids: ['evt_1', 'evt_2'],
      long_term_evidence_ids: ['evt_0'],
    }));
    const upsertBrief = vi.fn(async () => undefined);

    const result = await regenerateMemoryBrief({
      scopeKey: 'topic:k-particles',
      loadEvents: async () => [
        {
          id: 'evt_1',
          action: 'attempt',
          subject_kind: 'question',
          subject_id: 'q1',
          payload: { answer_md: 'wrong' },
          created_at: new Date('2026-05-27T01:00:00Z'),
        },
      ],
      searchFacts: async () => [{ id: 'mem_1', memory: 'Often confuses particles.' }],
      generate,
      upsertBrief,
      now: () => new Date('2026-05-27T02:00:00Z'),
    });

    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeKey: 'topic:k-particles',
        template: BRIEF_TEMPLATES.topic,
        facts: [{ id: 'mem_1', memory: 'Often confuses particles.' }],
      }),
    );
    expect(upsertBrief).toHaveBeenCalledWith(
      expect.objectContaining({
        scope_key: 'topic:k-particles',
        latest_evidence_at: new Date('2026-05-27T01:00:00Z'),
        evidence_count: 1,
        refreshed_at: new Date('2026-05-27T02:00:00Z'),
      }),
    );
    expect(result.wrote).toBe(true);
  });
});
