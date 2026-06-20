// U5 (YUK-203) — Artifact enum widen + ToolStateT v2 barrier.
//
// Covers §4.1 (every paper row now Artifact.parse()s) and §4.3 (the v2
// `sections[]` shape parses, malformed sections are rejected, flat + legacy
// rows still parse). Pure-Zod → unit partition.

import { describe, expect, it } from 'vitest';
import { ToolState, ToolStateSection } from './business';
import { Artifact } from './index';

function artifactRow(overrides: Record<string, unknown>): Record<string, unknown> {
  // A minimal-but-complete tool_quiz row shaped like the generated select schema.
  const now = new Date();
  return {
    id: 'a1',
    type: 'tool_quiz',
    title: '复习卷',
    parent_artifact_id: null,
    intent_source: 'review_plan',
    source: 'ai_generated',
    source_ref: null,
    body_blocks: null,
    knowledge_ids: [],
    attrs: {},
    tool_kind: 'review_plan',
    tool_state: { question_ids: ['q1', 'q2'] },
    generation_status: 'ready',
    verification_status: 'not_required',
    verification_summary: null,
    generated_by: null,
    verified_by: null,
    history: [],
    archived_at: null,
    created_at: now,
    updated_at: now,
    version: 0,
    ...overrides,
  };
}

describe('Artifact enum widen (§4.1)', () => {
  it.each(['review_plan', 'quiz_gen', 'embedded_check'])(
    'parses a paper row with intent_source/tool_kind = %s (previously threw)',
    (value) => {
      const r = Artifact.safeParse(artifactRow({ intent_source: value, tool_kind: value }));
      expect(r.success).toBe(true);
    },
  );

  // YUK-214 (Strategy D · S1) — ingest→practice bridge adds a fourth paper
  // provenance so an imported paper (tool_quiz built from imported questions)
  // parses + is recognised by /practice. Pure additive enum (§2.3).
  it('parses a paper row with intent_source/tool_kind = ingestion_paper (YUK-214)', () => {
    const r = Artifact.safeParse(
      artifactRow({ intent_source: 'ingestion_paper', tool_kind: 'ingestion_paper' }),
    );
    expect(r.success).toBe(true);
  });

  // ADR-0033 D6 (YUK-306) — interactive artifact provenance. Additive enum:
  // a copilot-authored type='interactive' row (attrs payload, no tool_state,
  // body_blocks null) must Artifact.parse, while unknown values stay rejected.
  it('parses an interactive row with intent_source/tool_kind = author_artifact (ADR-0033)', () => {
    const r = Artifact.safeParse(
      artifactRow({
        type: 'interactive',
        intent_source: 'author_artifact',
        tool_kind: 'author_artifact',
        // Reference, not practice — interactive rows carry no quiz tool_state.
        tool_state: null,
        attrs: { format: 'html', html: '<html></html>', origin: 'copilot_author_artifact' },
      }),
    );
    expect(r.success).toBe(true);
  });

  it('still parses a legacy tool_kind=quiz row (back-compat)', () => {
    const r = Artifact.safeParse(artifactRow({ intent_source: 'declared', tool_kind: 'quiz' }));
    expect(r.success).toBe(true);
  });

  it('still parses the pre-U5 intent_source values', () => {
    for (const value of ['learning_intent', 'declared', 'from_mistake', 'from_dream']) {
      expect(
        Artifact.safeParse(artifactRow({ intent_source: value, tool_kind: 'quiz' })).success,
      ).toBe(true);
    }
  });

  it('rejects an unknown intent_source', () => {
    expect(Artifact.safeParse(artifactRow({ intent_source: 'made_up' })).success).toBe(false);
  });

  it('parses a full U5 write_review_plan-shaped row (v2 sections + session_meta)', () => {
    const r = Artifact.safeParse(
      artifactRow({
        intent_source: 'review_plan',
        tool_kind: 'review_plan',
        tool_state: {
          question_ids: ['q1'],
          sections: [
            {
              knowledge_focus: ['k1'],
              feedback_policy: 'immediate',
              adaptation_policy: 'none',
              assignments: [
                {
                  question_id: 'q1',
                  primary_knowledge_id: 'k1',
                  secondary_knowledge_ids: [],
                  selection_reason: 'targets k1',
                  review_profile_snapshot: {},
                },
              ],
            },
          ],
          session_meta: { mode: 'initial_plan', sections: [] },
        },
      }),
    );
    expect(r.success).toBe(true);
    expect(r.success && r.data.tool_state?.sections?.[0].assignments[0].question_id).toBe('q1');
  });
});

describe('ToolStateT v2 barrier (§4.3)', () => {
  const assignment = {
    question_id: 'q1',
    part_ref: 'q1#a',
    primary_knowledge_id: 'k1',
    secondary_knowledge_ids: ['k2'],
    selection_reason: 'targets 宾语前置',
    review_profile_snapshot: { mastery: 0.4 },
  };
  const section = {
    knowledge_focus: ['k1'],
    feedback_policy: 'immediate',
    adaptation_policy: 'none',
    assignments: [assignment],
  };

  it('parses a flat {question_ids} tool_state (v1, back-compat)', () => {
    expect(ToolState.safeParse({ question_ids: ['q1'] }).success).toBe(true);
  });

  it('parses a U4 row whose plan lives only in session_meta (sections top-level undefined)', () => {
    const r = ToolState.safeParse({
      question_ids: ['q1'],
      session_meta: { sections: [section], labels: {} },
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.sections).toBeUndefined();
  });

  it('parses a v2 {question_ids, sections:[...]} tool_state', () => {
    const r = ToolState.safeParse({ question_ids: ['q1'], sections: [section] });
    expect(r.success).toBe(true);
    expect(r.success && r.data.sections?.[0].assignments[0].primary_knowledge_id).toBe('k1');
  });

  it('defaults secondary_knowledge_ids to [] when omitted', () => {
    const r = ToolStateSection.safeParse({
      ...section,
      assignments: [
        {
          question_id: 'q1',
          primary_knowledge_id: 'k1',
          selection_reason: 'x',
          review_profile_snapshot: {},
        },
      ],
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.assignments[0].secondary_knowledge_ids).toEqual([]);
  });

  it('rejects a malformed section missing primary_knowledge_id (barrier bites)', () => {
    const bad = {
      ...section,
      assignments: [{ question_id: 'q1', selection_reason: 'x', review_profile_snapshot: {} }],
    };
    expect(ToolStateSection.safeParse(bad).success).toBe(false);
    expect(ToolState.safeParse({ question_ids: ['q1'], sections: [bad] }).success).toBe(false);
  });

  it('rejects sections that is not an array', () => {
    expect(ToolState.safeParse({ question_ids: ['q1'], sections: { nope: true } }).success).toBe(
      false,
    );
  });
});
