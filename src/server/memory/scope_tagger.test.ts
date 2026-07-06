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

  // YUK-581 invariant guard (independent-review MINOR-1): the ingest-handler subject bridge
  // is the SOLE `subject:*` enqueue for qualifying events (attempt / review /
  // experimental:record_capture). That holds only while qualifying-event payloads never carry
  // a top-level subject_id / subject / domain — computeAffectedScopes would otherwise emit
  // `subject:<slug>` alongside the bridge's canonical `subject:<profile-id>`, double-
  // regenerating one conceptual subject brief. If this test breaks because a qualifying
  // writeEvent site grew such a payload field, re-adjudicate the bridge's no-double-invoke
  // argument in triggers.ts before loosening this assertion.
  it('yields no subject:* scope for qualifying-event payload shapes (YUK-581 bridge invariant)', () => {
    const qualifyingShapes = [
      // attempt (solve-session / paper-submit / enroll / mistakes payload shape)
      {
        action: 'attempt',
        subject_kind: 'question',
        subject_id: 'q1',
        payload: { answer_md: '答案', referenced_knowledge_ids: ['k1'] },
      },
      // review (submit.ts shape — fsrs subject ids are nested/array-valued and must stay untagged)
      {
        action: 'review',
        subject_kind: 'question',
        subject_id: 'q1',
        payload: {
          final_rating: 'again',
          fsrs_subject_ids: ['wenyan'],
          fsrs: { subject_id: 'wenyan' },
        },
      },
      // experimental:record_capture (records/queries.ts / enroll.ts shape — subject resolves
      // via the linked learning_record, not the payload)
      {
        action: 'experimental:record_capture',
        subject_kind: 'learning_record',
        subject_id: 'rec1',
        payload: { source: 'agent', record_kind: 'note' },
      },
    ];
    for (const evt of qualifyingShapes) {
      const scopes = computeAffectedScopes(evt);
      expect(scopes.filter((s) => s.startsWith('subject:'))).toEqual([]);
    }
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
        action: 'tool_use',
        subject_kind: 'query',
        subject_id: 'q',
        payload: {},
      }),
    ).toEqual(['global', 'meta:orchestrator_self']);
  });
});
