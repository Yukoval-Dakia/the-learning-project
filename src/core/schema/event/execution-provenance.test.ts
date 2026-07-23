import { describe, expect, it } from 'vitest';
import { JudgeOnEvent } from './known';

const base = {
  actor_kind: 'agent' as const,
  actor_ref: 'judge',
  action: 'judge' as const,
  subject_kind: 'event' as const,
  subject_id: 'attempt-1',
  outcome: 'success' as const,
  payload: {
    cause: {
      primary_category: 'other',
      secondary_categories: [],
      analysis_md: 'test',
      confidence: 1,
    },
    referenced_knowledge_ids: [],
  },
};

describe('JudgeOnEvent execution provenance', () => {
  it('parses historical events without provenance', () => {
    expect(JudgeOnEvent.parse(base).payload.execution_provenance).toBeUndefined();
  });

  it.each([
    'invoked',
    'supplied_verified',
    'supplied_unverified',
    'deterministic',
    'historical_unknown',
  ])('parses %s provenance', (kind) => {
    const parsed = JudgeOnEvent.parse({
      ...base,
      payload: {
        ...base.payload,
        execution_provenance: {
          version: 1,
          kind,
          prompt_fingerprint: 'a'.repeat(64),
          prompt_template_revision: 'judge-prompt-v1',
        },
      },
    });
    expect(parsed.payload.execution_provenance?.kind).toBe(kind);
  });
});
