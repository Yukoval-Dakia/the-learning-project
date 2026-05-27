import { describe, expect, it } from 'vitest';
import { computeAffectedScopes } from './scope_tagger';

describe('computeAffectedScopes', () => {
  it('always includes global and tags referenced knowledge ids as topic scopes', () => {
    expect(
      computeAffectedScopes({
        action: 'attempt',
        subject_kind: 'question',
        subject_id: 'q1',
        payload: {
          referenced_knowledge_ids: ['k-wenyan-particles', 'k-punctuation'],
        },
      }),
    ).toEqual(['global', 'topic:k-wenyan-particles', 'topic:k-punctuation']);
  });

  it('tags explicit subject domains from payload', () => {
    expect(
      computeAffectedScopes({
        action: 'review',
        subject_kind: 'question',
        subject_id: 'q1',
        payload: {
          subject_id: 'wenyan',
          knowledge_ids: ['k1'],
        },
      }),
    ).toEqual(['global', 'subject:wenyan', 'topic:k1']);
  });

  it('tags judge/user-cause primary category as a mistake cluster', () => {
    expect(
      computeAffectedScopes({
        action: 'judge',
        subject_kind: 'event',
        subject_id: 'evt_attempt',
        payload: {
          cause: {
            primary_category: 'Particle / Punctuation Confusion',
          },
          referenced_knowledge_ids: ['k1'],
        },
      }),
    ).toEqual(['global', 'topic:k1', 'mistake_cluster:particle_punctuation_confusion']);
  });

  it('routes chat and tool-use style events to orchestrator self memory', () => {
    expect(
      computeAffectedScopes({
        action: 'experimental:tool_use',
        subject_kind: 'query',
        subject_id: 'q',
        payload: {},
      }),
    ).toEqual(['global', 'meta:orchestrator_self']);
  });
});
