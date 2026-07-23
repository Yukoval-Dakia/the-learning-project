import { describe, expect, it } from 'vitest';

import {
  QuestionAnswerAnchor,
  QuestionGenerationBinding,
  QuestionGenerationPlan,
  structurallyVerifyGeneratedQuestion,
} from './question-generation-grounding';

const anchor = QuestionAnswerAnchor.parse({
  id: 'anchor_1',
  version: 1,
  schema_version: 1,
  source: {
    artifact_kind: 'source_document',
    artifact_id: 'doc_1',
    version: 7,
    content_hash: 'sha256:source-v7',
    locator: { kind: 'text_span', start: 12, end: 18, exact_text: '北京' },
  },
  canonical_answer: { kind: 'text', value: '北京' },
  provenance: { kind: 'ai_extracted', task_run_id: 'run_anchor' },
  content_hash: 'sha256:anchor-v1',
});

const plan = QuestionGenerationPlan.parse({
  id: 'plan_1',
  version: 1,
  schema_version: 1,
  demand: { kind: 'knowledge', ref_id: 'k_1' },
  knowledge_ids: ['k_1'],
  requested_kind: 'fill_blank',
  requested_answer_class: 'exact',
  answer_anchor: { id: anchor.id, version: anchor.version, content_hash: anchor.content_hash },
  constraints: { language: 'zh-CN' },
  provenance: { kind: 'ai_planned', task_run_id: 'run_plan' },
  content_hash: 'sha256:plan-v1',
});

const binding = QuestionGenerationBinding.parse({
  plan: { id: plan.id, version: plan.version, content_hash: plan.content_hash },
  answer_anchor: { id: anchor.id, version: anchor.version, content_hash: anchor.content_hash },
  comparator_policy: { id: 'none', version: 1, content_hash: 'sha256:no-comparator' },
});

describe('question generation grounding contracts (YUK-350)', () => {
  it('requires an exact immutable source span and canonical answer', () => {
    expect(
      QuestionAnswerAnchor.safeParse({
        ...anchor,
        source: { ...anchor.source, locator: { kind: 'text_span', start: 18, end: 12 } },
      }).success,
    ).toBe(false);
    expect(
      QuestionAnswerAnchor.safeParse({ ...anchor, canonical_answer: { kind: 'text', value: '' } })
        .success,
    ).toBe(false);
  });

  it('binds a plan to exact anchor identity, version, and content hash', () => {
    expect(
      QuestionGenerationPlan.safeParse({
        ...plan,
        answer_anchor: { ...plan.answer_anchor, content_hash: '' },
      }).success,
    ).toBe(false);
  });

  it('rejects a generated question when an exact binding has changed', () => {
    const result = structurallyVerifyGeneratedQuestion({
      binding,
      plan,
      anchor: { ...anchor, content_hash: 'sha256:changed' },
      generated: { kind: 'fill_blank', reference_md: '北京' },
    });

    expect(result).toEqual({
      structural_status: 'vetoed',
      objective_correctness: 'unverified',
      disposition: 'reject',
      vetoes: ['answer_anchor_binding_mismatch', 'plan_answer_anchor_binding_mismatch'],
    });
  });

  it('holds structurally valid output for review because no proven comparator exists', () => {
    const result = structurallyVerifyGeneratedQuestion({
      binding,
      plan,
      anchor,
      generated: { kind: 'fill_blank', reference_md: '北京' },
    });

    expect(result).toEqual({
      structural_status: 'no_veto',
      objective_correctness: 'unverified',
      disposition: 'needs_review',
      vetoes: [],
    });
  });

  it('never treats a matching generator-authored reference as proof without an anchor', () => {
    const result = structurallyVerifyGeneratedQuestion({
      binding,
      plan,
      anchor: null,
      generated: { kind: 'fill_blank', reference_md: '北京' },
    });

    expect(result.disposition).toBe('reject');
    expect(result.objective_correctness).toBe('unverified');
    expect(result.vetoes).toContain('answer_anchor_missing');
  });
});
