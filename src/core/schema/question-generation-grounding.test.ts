import { describe, expect, it } from 'vitest';

import {
  QuestionAnswerAnchor,
  QuestionGenerationBinding,
  QuestionGenerationPlan,
  SourceLocatorValidationError,
  type SourceSpanLocatorT,
  structurallyVerifyGeneratedQuestion,
  validateSourceLocatorBytes,
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

  it('accepts exact page spans and page-region coordinates with page identity', () => {
    const pageSpan = {
      ...anchor,
      source: {
        ...anchor.source,
        locator: {
          kind: 'page_text_span',
          page_id: 'page_7',
          page_version: 2,
          page_index: 6,
          start: 12,
          end: 18,
          exact_text: '北京',
        },
      },
    };
    const region = {
      ...anchor,
      source: {
        ...anchor.source,
        locator: {
          kind: 'page_region',
          page_id: 'page_7',
          page_version: 2,
          page_index: 6,
          bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        },
      },
    };

    expect(QuestionAnswerAnchor.safeParse(pageSpan).success).toBe(true);
    expect(QuestionAnswerAnchor.safeParse(region).success).toBe(true);
    expect(
      QuestionAnswerAnchor.safeParse({
        ...region,
        source: { ...region.source, locator: { ...region.source.locator, page_id: '' } },
      }).success,
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

describe('validateSourceLocatorBytes — half-open UTF-8 byte semantics (YUK-350)', () => {
  // '学而时习之' — five CJK chars, 3 bytes each = 15 UTF-8 bytes.
  const body = '学而时习之';
  const bytes = new TextEncoder().encode(body);

  const textSpan = (start: number, end: number, exact_text: string): SourceSpanLocatorT => ({
    kind: 'text_span',
    start,
    end,
    exact_text,
  });

  it('accepts a byte-exact multibyte (CJK) span', () => {
    // '学而' occupies bytes [0, 6); '之' occupies [12, 15).
    expect(() => validateSourceLocatorBytes(textSpan(0, 6, '学而'), bytes)).not.toThrow();
    expect(() => validateSourceLocatorBytes(textSpan(12, 15, '之'), bytes)).not.toThrow();
    // The full body is 15 bytes, not string .length (5) — proves byte, not UTF-16.
    expect(bytes.length).toBe(15);
    expect(() => validateSourceLocatorBytes(textSpan(0, 15, body), bytes)).not.toThrow();
  });

  it('rejects a boundary that splits a codepoint (byte offset lands mid-character)', () => {
    // [0, 4) cuts '而' in half → decodes to U+FFFD, never equals '学而'.
    expect(() => validateSourceLocatorBytes(textSpan(0, 4, '学而'), bytes)).toThrow(
      SourceLocatorValidationError,
    );
    // A UTF-16-style offset (end=2 for the 2-char '学而') under-reads in bytes.
    expect(() => validateSourceLocatorBytes(textSpan(0, 2, '学而'), bytes)).toThrow(/exact_text/);
  });

  it('treats [start, end) as half-open: end is exclusive and may equal the byte length', () => {
    expect(() => validateSourceLocatorBytes(textSpan(0, 15, body), bytes)).not.toThrow();
    // end beyond the byte length is out of range.
    expect(() => validateSourceLocatorBytes(textSpan(0, 16, body), bytes)).toThrow(
      /exceeds authoritative source byte length/,
    );
    // Empty / inverted ranges are rejected.
    expect(() => validateSourceLocatorBytes(textSpan(6, 6, ''), bytes)).toThrow(
      /greater than start/,
    );
  });

  it('fails closed when authoritative bytes are missing (never a silent pass)', () => {
    expect(() => validateSourceLocatorBytes(textSpan(0, 6, '学而'), null)).toThrow(
      /authoritative source bytes/,
    );
    const pageSpan: SourceSpanLocatorT = {
      kind: 'page_text_span',
      page_id: 'page_1',
      page_version: 1,
      page_index: 0,
      start: 0,
      end: 6,
      exact_text: '学而',
    };
    expect(() => validateSourceLocatorBytes(pageSpan, null)).toThrow(SourceLocatorValidationError);
    expect(() => validateSourceLocatorBytes(pageSpan, bytes)).not.toThrow();
  });

  it('fails closed for a page_region locator with no authoritative bytes, passes with them', () => {
    const region: SourceSpanLocatorT = {
      kind: 'page_region',
      page_id: 'page_1',
      page_version: 1,
      page_index: 0,
      bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    };
    expect(() => validateSourceLocatorBytes(region, null)).toThrow(/authoritative source bytes/);
    expect(() => validateSourceLocatorBytes(region, bytes)).not.toThrow();
  });
});
