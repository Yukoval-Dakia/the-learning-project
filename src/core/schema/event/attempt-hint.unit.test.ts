// YUK-352 — hint-event 留痕：AttemptOnQuestion.payload 新增 hints_used / final_hint_level。
//
// hint 计数现在已在产生（solve 链客户端逐次升级 hint_index）但被丢弃——本字段把它落到
// attempt event 的 payload 上「先攒数据」（GPT §3 L3 / §6.4 hint_dependence 假学习探测的
// 前置原料）。两字段 OPTIONAL：非 tutor-solve 路径（卷题 / FSRS 复习 / copilot 提示）的
// attempt 不带 → 既有读路径逐字不变（byte-identical 回归锚）。
import { describe, expect, it } from 'vitest';
import { AttemptOnQuestion, KnownEvent } from './known';

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

describe('AttemptOnQuestion hint capture (YUK-352)', () => {
  it('accepts hints_used + final_hint_level on the attempt payload', () => {
    const parsed = AttemptOnQuestion.safeParse(attemptRow({ hints_used: 2, final_hint_level: 1 }));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.payload.hints_used).toBe(2);
      expect(parsed.data.payload.final_hint_level).toBe(1);
    }
  });

  it('accepts hints_used = 0 (solved without ever asking for a hint)', () => {
    const parsed = AttemptOnQuestion.safeParse(attemptRow({ hints_used: 0 }));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.payload.hints_used).toBe(0);
  });

  it('stays optional — a legacy attempt with no hint fields still parses (byte-identical read path)', () => {
    const parsed = AttemptOnQuestion.safeParse(attemptRow({}));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.payload.hints_used).toBeUndefined();
      expect(parsed.data.payload.final_hint_level).toBeUndefined();
    }
  });

  it('rejects a negative hints_used (count is a non-negative integer)', () => {
    const parsed = AttemptOnQuestion.safeParse(attemptRow({ hints_used: -1 }));
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-integer hints_used', () => {
    const parsed = AttemptOnQuestion.safeParse(attemptRow({ hints_used: 1.5 }));
    expect(parsed.success).toBe(false);
  });

  it('parses through the KnownEvent union with hint fields present', () => {
    const parsed = KnownEvent.safeParse(attemptRow({ hints_used: 3, final_hint_level: 2 }));
    expect(parsed.success).toBe(true);
  });
});
