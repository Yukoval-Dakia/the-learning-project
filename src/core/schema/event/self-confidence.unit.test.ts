// YUK-444 (A10 答题置信度自评)：ReviewOnQuestion.payload 新增 self_confidence（学生看判定前对
// 本次作答的主观把握，1-5 整数）。
//
// 该字段 OPTIONAL 且 observe-only：跳过 / 客观题 auto-commit / 历史 review 恒缺省 → 既有读路径逐字
// 不变（byte-identical 回归锚，仿 reasoning-trace.unit.test.ts / attempt-hint.unit.test.ts）。命名刻意
// 用 self_confidence 而非 confidence（后者是 judge 置信度）。engagement 红线（零强制）= 字段全 optional。
import { describe, expect, it } from 'vitest';
import { KnownEvent, ReviewOnQuestion } from './known';

// ReviewOnQuestion has an fsrs_rating ↔ outcome invariant (again→failure, else success).
// Use good→success so the base row is valid before overrides.
function reviewRow(payloadOverrides: Record<string, unknown>) {
  return {
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'review',
    subject_kind: 'question',
    subject_id: 'q1',
    outcome: 'success',
    payload: {
      fsrs_rating: 'good',
      fsrs_state_after: {
        due: '2026-01-01T00:00:00.000Z',
        stability: 1,
        difficulty: 5,
        elapsed_days: 0,
        scheduled_days: 1,
        learning_steps: 0,
        reps: 1,
        lapses: 0,
        state: 'review',
        last_review: '2026-01-01T00:00:00.000Z',
      },
      user_response_md: 'a+b',
      referenced_knowledge_ids: ['kc1'],
      ...payloadOverrides,
    },
  };
}

describe('ReviewOnQuestion self_confidence capture (YUK-444)', () => {
  it('accepts a 1-5 self_confidence integer on the review payload', () => {
    const parsed = ReviewOnQuestion.safeParse(reviewRow({ self_confidence: 4 }));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.payload.self_confidence).toBe(4);
  });

  it('stays optional — a legacy review with no self_confidence still parses (byte-identical read path)', () => {
    const parsed = ReviewOnQuestion.safeParse(reviewRow({}));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.payload.self_confidence).toBeUndefined();
  });

  it('accepts both bounds (1 and 5) and rejects out-of-range / non-integer values', () => {
    expect(ReviewOnQuestion.safeParse(reviewRow({ self_confidence: 1 })).success).toBe(true);
    expect(ReviewOnQuestion.safeParse(reviewRow({ self_confidence: 5 })).success).toBe(true);
    expect(ReviewOnQuestion.safeParse(reviewRow({ self_confidence: 0 })).success).toBe(false);
    expect(ReviewOnQuestion.safeParse(reviewRow({ self_confidence: 6 })).success).toBe(false);
    expect(ReviewOnQuestion.safeParse(reviewRow({ self_confidence: 3.5 })).success).toBe(false);
  });

  it('is independent of the judge `confidence` field — self_confidence lives only on the review payload', () => {
    // Naming guard: self_confidence is the learner's self-report, NOT the judge's
    // confidence (which rides the judge result). They must not be conflated.
    const parsed = ReviewOnQuestion.safeParse(reviewRow({ self_confidence: 2 }));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.payload.self_confidence).toBe(2);
      expect('confidence' in parsed.data.payload).toBe(false);
    }
  });

  it('parses through the KnownEvent union with self_confidence present', () => {
    expect(KnownEvent.safeParse(reviewRow({ self_confidence: 3 })).success).toBe(true);
  });

  it('coexists with reasoning_trace (both YUK-562 + YUK-444 capture fields on one review)', () => {
    const parsed = ReviewOnQuestion.safeParse(
      reviewRow({ self_confidence: 5, reasoning_trace: '先套勾股定理' }),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.payload.self_confidence).toBe(5);
      expect(parsed.data.payload.reasoning_trace).toBe('先套勾股定理');
    }
  });
});
