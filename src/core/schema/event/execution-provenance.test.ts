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

  it('rejects trusted fields on untrusted and deterministic kinds', () => {
    for (const kind of ['supplied_unverified', 'deterministic', 'historical_unknown']) {
      expect(
        JudgeOnEvent.safeParse({
          ...base,
          payload: {
            ...base.payload,
            execution_provenance: {
              version: 1,
              kind,
              task_run_id: 'tr-fake',
              provider: 'fake-provider',
              model: 'fake-model',
              prompt_fingerprint: 'a'.repeat(64),
              prompt_template_revision: 'judge-prompt-v1',
            },
          },
        }).success,
      ).toBe(false);
    }
  });

  it('requires authoritative fields for trusted model kinds', () => {
    for (const kind of ['invoked', 'supplied_verified']) {
      expect(
        JudgeOnEvent.safeParse({
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
        }).success,
      ).toBe(false);
    }
  });

  it.each(['supplied_unverified', 'deterministic', 'historical_unknown'])(
    'parses %s provenance',
    (kind) => {
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
    },
  );

  it.each(['invoked', 'supplied_verified'])('parses trusted %s provenance', (kind) => {
    const parsed = JudgeOnEvent.parse({
      ...base,
      payload: {
        ...base.payload,
        execution_provenance: {
          version: 1,
          kind,
          task_run_id: 'tr-1',
          provider: 'provider',
          model: 'model',
          prompt_fingerprint: 'a'.repeat(64),
          prompt_template_revision: 'judge-prompt-v1',
        },
      },
    });
    expect(parsed.payload.execution_provenance?.kind).toBe(kind);
  });
});
