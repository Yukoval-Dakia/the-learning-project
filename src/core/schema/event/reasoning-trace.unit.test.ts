// YUK-562 — process-data 最小采集：AttemptOnQuestion.payload / ReviewOnQuestion.payload
// 新增 reasoning_trace（学生自述解题思路 / 过程文本）。
//
// 该字段 OPTIONAL：无过程文本的路径（卷题 / FSRS 复习 / copilot 提示 / 历史事件）恒缺省 →
// 既有读路径逐字不变（byte-identical 回归锚，仿 attempt-hint.unit.test.ts）。engagement
// 红线（零强制）在后端表现为字段全 optional。
import { describe, expect, it } from 'vitest';
import { AttemptOnQuestion, KnownEvent, ReviewOnQuestion } from './known';

function attemptRow(payloadOverrides: Record<string, unknown>) {
  return {
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: 'q1',
    outcome: 'success',
    payload: {
      answer_md: 'a+b',
      answer_image_refs: [],
      referenced_knowledge_ids: ['kc1'],
      ...payloadOverrides,
    },
  };
}

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

describe('AttemptOnQuestion reasoning_trace capture (YUK-562)', () => {
  it('accepts a reasoning_trace string on the attempt payload', () => {
    const parsed = AttemptOnQuestion.safeParse(
      attemptRow({ reasoning_trace: '先设未知数 x，再列方程 2x+3=7' }),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.payload.reasoning_trace).toBe('先设未知数 x，再列方程 2x+3=7');
    }
  });

  it('stays optional — a legacy attempt with no reasoning_trace still parses (byte-identical read path)', () => {
    const parsed = AttemptOnQuestion.safeParse(attemptRow({}));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.payload.reasoning_trace).toBeUndefined();
  });

  it('accepts a 4000-char reasoning_trace and rejects one above the bound', () => {
    expect(
      AttemptOnQuestion.safeParse(attemptRow({ reasoning_trace: 'x'.repeat(4000) })).success,
    ).toBe(true);
    expect(
      AttemptOnQuestion.safeParse(attemptRow({ reasoning_trace: 'x'.repeat(4001) })).success,
    ).toBe(false);
  });

  it('parses through the KnownEvent union with reasoning_trace present', () => {
    const parsed = KnownEvent.safeParse(attemptRow({ reasoning_trace: '思路：分类讨论' }));
    expect(parsed.success).toBe(true);
  });
});

describe('ReviewOnQuestion reasoning_trace capture (YUK-562)', () => {
  it('accepts a reasoning_trace string on the review payload', () => {
    const parsed = ReviewOnQuestion.safeParse(
      reviewRow({ reasoning_trace: '回忆：这是二次函数顶点式' }),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.payload.reasoning_trace).toBe('回忆：这是二次函数顶点式');
    }
  });

  it('stays optional — a legacy review with no reasoning_trace still parses (byte-identical read path)', () => {
    const parsed = ReviewOnQuestion.safeParse(reviewRow({}));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.payload.reasoning_trace).toBeUndefined();
  });

  it('enforces the same 4000-char bound on the review payload', () => {
    expect(
      ReviewOnQuestion.safeParse(reviewRow({ reasoning_trace: 'x'.repeat(4000) })).success,
    ).toBe(true);
    expect(
      ReviewOnQuestion.safeParse(reviewRow({ reasoning_trace: 'x'.repeat(4001) })).success,
    ).toBe(false);
  });

  it('parses through the KnownEvent union with reasoning_trace present', () => {
    const parsed = KnownEvent.safeParse(reviewRow({ reasoning_trace: '思路：套用勾股定理' }));
    expect(parsed.success).toBe(true);
  });
});
