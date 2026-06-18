// YUK-350 (B5 increment C) — unit tests for the unified verify contract.
//
// docs/adr/0038-unified-verify-contract-plan-then-generate.md 决定 #1 (Verifier
// Router: 三闸收敛到 QuizGen 五轴多信号模板) + 决定 #5 ('error' 通道).
//
// These tests are the TDD anchor for `toUnifiedVerifyResult` — the pure projection
// helper that maps each promote-gated handler's current shape (quiz multi-axis
// result / source per-check array + promote bool / variant verdict) onto ONE unified
// UnifiedVerifyResult { axes, overall, failure_class?, summary_md, confidence }.
//
// No DB, no AI, no IO — pure schema + projection.

import { describe, expect, it } from 'vitest';

import { NoteVerificationResult } from './business';
import { QuizVerificationResult } from './quiz_gen';
import {
  UnifiedVerifyResult,
  type UnifiedVerifyResultT,
  toUnifiedVerifyResult,
} from './verify-contract';

describe('UnifiedVerifyResult schema', () => {
  it('accepts the 4-value overall including error', () => {
    for (const overall of ['pass', 'needs_review', 'fail', 'error'] as const) {
      const candidate: UnifiedVerifyResultT = {
        axes: [{ axis_name: 'grounding', verdict: 'pass' }],
        overall,
        summary_md: 'ok',
        confidence: 0.9,
      };
      expect(UnifiedVerifyResult.safeParse(candidate).success).toBe(true);
    }
  });

  it('accepts an optional failure_class', () => {
    const parsed = UnifiedVerifyResult.safeParse({
      axes: [],
      overall: 'error',
      failure_class: 'system_error',
      summary_md: 'boom',
      confidence: 0,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown overall value', () => {
    const parsed = UnifiedVerifyResult.safeParse({
      axes: [],
      overall: 'maybe',
      summary_md: 'x',
      confidence: 0.5,
    });
    expect(parsed.success).toBe(false);
  });
});

describe('toUnifiedVerifyResult — quiz', () => {
  it('quiz pass maps to overall pass with no failure_class', () => {
    const unified = toUnifiedVerifyResult({
      source: 'quiz',
      overall: 'pass',
      promote: true,
      summary_md: '复核通过',
      confidence: 0.88,
      checks: [
        { axis_name: 'grounding', verdict: 'pass' },
        { axis_name: 'knowledge_hit', verdict: 'pass' },
        { axis_name: 'copy_safety', verdict: 'original', note: 'overlap 0.10' },
      ],
    });
    expect(unified.overall).toBe('pass');
    expect(unified.failure_class).toBeUndefined();
    expect(unified.summary_md).toBe('复核通过');
    expect(unified.confidence).toBe(0.88);
    expect(unified.axes.map((a) => a.axis_name)).toContain('grounding');
    expect(UnifiedVerifyResult.safeParse(unified).success).toBe(true);
  });

  it('quiz non-promote (overall fail) maps to overall fail + validation_failure', () => {
    const unified = toUnifiedVerifyResult({
      source: 'quiz',
      overall: 'fail',
      promote: false,
      summary_md: '事实不成立',
      confidence: 0.4,
      checks: [{ axis_name: 'grounding', verdict: 'fail', note: '与来源不符' }],
    });
    expect(unified.overall).toBe('fail');
    expect(unified.failure_class).toBe('validation_failure');
  });

  it('quiz needs_review maps to overall needs_review + validation_failure', () => {
    const unified = toUnifiedVerifyResult({
      source: 'quiz',
      overall: 'needs_review',
      promote: false,
      summary_md: '语义不够清晰',
      confidence: 0.6,
      checks: [{ axis_name: 'knowledge_hit', verdict: 'unclear' }],
    });
    expect(unified.overall).toBe('needs_review');
    expect(unified.failure_class).toBe('validation_failure');
  });
});

describe('toUnifiedVerifyResult — source (per-check array rolled up)', () => {
  it('all checks pass + promote rolls up to overall pass, no failure_class', () => {
    const unified = toUnifiedVerifyResult({
      source: 'source',
      promote: true,
      summary_md: 'tier-2 源校验通过',
      confidence: 1,
      checks: [
        { check: 'structure_completeness', verdict: 'pass', reason: 'all fields present' },
        { check: 'source_consistency', verdict: 'pass', reason: 'grounded' },
        { check: 'dedup', verdict: 'pass', reason: 'no near-dup' },
        { check: 'solve_check', verdict: 'unsupported', reason: 'no signal' },
      ],
    });
    expect(unified.overall).toBe('pass');
    expect(unified.failure_class).toBeUndefined();
    // per-check array → axes[], preserving check name + verdict.
    expect(unified.axes).toHaveLength(4);
    expect(unified.axes.find((a) => a.axis_name === 'source_consistency')?.verdict).toBe('pass');
  });

  it('a failing source check rolls up to overall fail + failure_class validation_failure', () => {
    const unified = toUnifiedVerifyResult({
      source: 'source',
      promote: false,
      summary_md: 'tier-2 源校验失败',
      confidence: 1,
      checks: [
        { check: 'structure_completeness', verdict: 'pass', reason: 'ok' },
        {
          check: 'source_consistency',
          verdict: 'fail',
          reason: 'source_ref disagrees with provenance url',
        },
      ],
    });
    // This fills the source-verify previously-missing overall WITHOUT changing the
    // promote predicate (promote is passed in unchanged).
    expect(unified.overall).toBe('fail');
    expect(unified.failure_class).toBe('validation_failure');
  });

  it('not-promoted with no failing check (e.g. archived knowledge) rolls up to needs_review', () => {
    // source_verify can have promote=false while every formal check passes (the
    // knowledge-survival gate is outside the checks[] array). That is NOT a check
    // fail → it must not be reported as overall fail; it is a needs_review.
    const unified = toUnifiedVerifyResult({
      source: 'source',
      promote: false,
      summary_md: 'knowledge archived after sourcing',
      confidence: 1,
      checks: [
        { check: 'structure_completeness', verdict: 'pass', reason: 'ok' },
        { check: 'source_consistency', verdict: 'pass', reason: 'grounded' },
      ],
    });
    expect(unified.overall).toBe('needs_review');
    expect(unified.failure_class).toBe('validation_failure');
  });
});

describe('toUnifiedVerifyResult — variant', () => {
  it('variant verdict=pass maps to overall pass, no failure_class', () => {
    const unified = toUnifiedVerifyResult({
      source: 'variant',
      verdict: 'pass',
      cause_targeting: 'on_target',
      failure_reasons: [],
      summary_md: '变式覆盖了 cause',
      confidence: 0.9,
    });
    expect(unified.overall).toBe('pass');
    expect(unified.failure_class).toBeUndefined();
    expect(unified.axes.find((a) => a.axis_name === 'cause_targeting')?.verdict).toBe('on_target');
  });

  it('variant verdict=fail maps to overall fail + validation_failure, reasons in note', () => {
    const unified = toUnifiedVerifyResult({
      source: 'variant',
      verdict: 'fail',
      cause_targeting: 'off_target',
      failure_reasons: ['变式飘到了无关知识点'],
      summary_md: '无法重现 cause',
      confidence: 0.3,
    });
    expect(unified.overall).toBe('fail');
    expect(unified.failure_class).toBe('validation_failure');
  });
});

describe('toUnifiedVerifyResult — note (YUK-350 increment 2)', () => {
  it('note verdict=pass maps to overall pass, no failure_class, no axes for a clean pass', () => {
    const unified = toUnifiedVerifyResult({
      source: 'note',
      verdict: 'pass',
      summary_md: '结构完整，未发现明显问题。',
      confidence: 0.82,
      issues: [],
    });
    expect(unified.overall).toBe('pass');
    expect(unified.failure_class).toBeUndefined();
    expect(unified.summary_md).toBe('结构完整，未发现明显问题。');
    expect(unified.confidence).toBe(0.82);
    expect(unified.axes).toHaveLength(0);
    expect(UnifiedVerifyResult.safeParse(unified).success).toBe(true);
  });

  it('note verdict=needs_review maps to overall needs_review + validation_failure, issues → axes', () => {
    const unified = toUnifiedVerifyResult({
      source: 'note',
      verdict: 'needs_review',
      summary_md: '例子部分需要人工复核。',
      confidence: 0.58,
      issues: [
        {
          block_id: 'b2',
          severity: 'warn',
          category: 'factuality',
          message: '例句解释缺少文本证据。',
          suggested_fix_md: '补充原句出处或改成不确定表述。',
        },
      ],
    });
    expect(unified.overall).toBe('needs_review');
    expect(unified.failure_class).toBe('validation_failure');
    // a note can NEVER project overall='fail' (the note verdict has no 'fail').
    expect(unified.overall).not.toBe('fail');
    expect(unified.axes).toHaveLength(1);
    const axis = unified.axes[0];
    expect(axis.axis_name).toBe('factuality');
    expect(axis.verdict).toBe('fail');
    expect(axis.note).toBe('例句解释缺少文本证据。');
    expect(UnifiedVerifyResult.safeParse(unified).success).toBe(true);
  });

  it('note never projects overall=error from the verdict path (only the catch-bottom can)', () => {
    for (const verdict of ['pass', 'needs_review'] as const) {
      const unified = toUnifiedVerifyResult({
        source: 'note',
        verdict,
        summary_md: 'x',
        confidence: 0.5,
        issues: [],
      });
      expect(unified.overall).not.toBe('error');
    }
  });
});

describe('toUnifiedVerifyResult — system-error (catch path)', () => {
  it('a catch-path error input maps to overall error + failure_class system_error', () => {
    const unified = toUnifiedVerifyResult({
      source: 'system_error',
      summary_md: 'quiz_verify failed: JSON.parse failed',
      error: 'JSON.parse failed',
    });
    expect(unified.overall).toBe('error');
    expect(unified.failure_class).toBe('system_error');
    expect(unified.confidence).toBe(0);
    expect(unified.axes).toHaveLength(0);
    expect(UnifiedVerifyResult.safeParse(unified).success).toBe(true);
  });
});

// ---- RL1 red line 1 regression: the LLM-parse schema can NEVER self-report error ----
describe('QuizVerificationResult red line 1 (model cannot self-report error)', () => {
  it('parses the 3 model verdicts pass|needs_review|fail', () => {
    for (const overall of ['pass', 'needs_review', 'fail'] as const) {
      const parsed = QuizVerificationResult.safeParse({
        grounding: { verdict: 'pass' },
        copy_safety: { verdict: 'original' },
        knowledge_hit: { verdict: 'pass' },
        overall,
        summary_md: 'x',
        confidence: 0.5,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it("CANNOT produce overall='error' through the LLM parse path (red line 1)", () => {
    const parsed = QuizVerificationResult.safeParse({
      grounding: { verdict: 'pass' },
      copy_safety: { verdict: 'original' },
      knowledge_hit: { verdict: 'pass' },
      overall: 'error',
      summary_md: 'x',
      confidence: 0.5,
    });
    expect(parsed.success).toBe(false);
  });
});

// ---- RL1 red line 1 regression for the NOTE LLM-parse schema (YUK-350 increment 2) ----
// The note verdict is FROZEN at the 2-value pass|needs_review (NO fail). The result-layer
// 'error' value lives ONLY on the catch-bottom system_error projection — the model can
// never self-report a system error through the note parse path.
describe('NoteVerificationResult red line 1 (model cannot self-report error)', () => {
  it('parses the 2 model verdicts pass|needs_review', () => {
    for (const verdict of ['pass', 'needs_review'] as const) {
      const parsed = NoteVerificationResult.safeParse({
        verdict,
        summary_md: 'x',
        issues: [],
        confidence: 0.5,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it("CANNOT produce verdict='fail' (the note verdict has no fail)", () => {
    const parsed = NoteVerificationResult.safeParse({
      verdict: 'fail',
      summary_md: 'x',
      issues: [],
      confidence: 0.5,
    });
    expect(parsed.success).toBe(false);
  });

  it("CANNOT produce verdict='error' through the LLM parse path (red line 1)", () => {
    const parsed = NoteVerificationResult.safeParse({
      verdict: 'error',
      summary_md: 'x',
      issues: [],
      confidence: 0.5,
    });
    expect(parsed.success).toBe(false);
  });
});
