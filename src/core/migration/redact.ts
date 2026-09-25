import { sha256Hex } from './canonical';
import type { MigrationCapture, RawEventRow } from './types';

// ====================================================================
// YUK-1048 — 捕获脱敏（grounding §14 manifest 的 redacted flags 支撑）
// ====================================================================
//
// D19 census 纪律是「无原始 learner 内容」；cutover 捕获默认需要原文保真
// （迁移对账要 body），但工具必须支持 --redact 产出可外发的脱敏工件：
// 学习者自由文本与模型分析文本替换为 {__redacted, sha256, length}。
//
// 只脱敏【内容】，不动结构/标记 —— 分类器读的是 marker（source/
// unsupported_judge/judge_route/question_snapshot 存在性等），脱敏后分类
// 结果不变（unit test 钉住这一点）。题目快照（question_snapshot）是题面
// 内容不是 learner 内容，保留。

export const REDACTED_EVENT_PAYLOAD_FIELDS = [
  'answer_md',
  'reasoning_trace',
  'wrong_answer_md',
] as const;

export const REDACTED_NESTED_CAUSE_FIELDS = ['analysis_md'] as const;

export const REDACTED_ANSWER_FIELDS = ['content_md', 'vision_extracted'] as const;

function redactText(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return {
    __redacted: true as const,
    sha256: sha256Hex(value),
    length: value.length,
  };
}

function redactEventPayload(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }
  const out: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  for (const field of REDACTED_EVENT_PAYLOAD_FIELDS) {
    if (typeof out[field] === 'string') {
      out[field] = redactText(out[field]);
    }
  }
  const cause = out.cause;
  if (cause !== null && typeof cause === 'object' && !Array.isArray(cause)) {
    const causeOut: Record<string, unknown> = { ...(cause as Record<string, unknown>) };
    for (const field of REDACTED_NESTED_CAUSE_FIELDS) {
      if (typeof causeOut[field] === 'string') {
        causeOut[field] = redactText(causeOut[field]);
      }
    }
    out.cause = causeOut;
  }
  return out;
}

function redactAnswer(
  answer: MigrationCapture['rawFacts']['answers'][number],
): MigrationCapture['rawFacts']['answers'][number] {
  return {
    ...answer,
    content_md:
      typeof answer.content_md === 'string'
        ? (redactText(answer.content_md) as unknown as string)
        : answer.content_md,
    vision_extracted:
      typeof answer.vision_extracted === 'string'
        ? (redactText(answer.vision_extracted) as unknown as string)
        : answer.vision_extracted,
  };
}

/**
 * 返回脱敏后的新 capture（原对象不可变）。清单记录 redaction.applied，
 * 哈希覆盖的是脱敏后形态 —— 同一 DB 状态在固定脱敏模式下哈希仍稳定。
 */
export function redactMigrationCapture(capture: MigrationCapture): MigrationCapture {
  const events: RawEventRow[] = capture.rawFacts.events.map((e) => ({
    ...e,
    payload: redactEventPayload(e.payload),
  }));
  return {
    ...capture,
    rawFacts: {
      ...capture.rawFacts,
      events,
      answers: capture.rawFacts.answers.map(redactAnswer),
    },
  };
}

/** manifest.redaction.fields 的规范清单（与上述实现一一对应）。 */
export function redactedFieldList(): string[] {
  return [
    ...REDACTED_EVENT_PAYLOAD_FIELDS.map((f) => `event.payload.${f}`),
    ...REDACTED_NESTED_CAUSE_FIELDS.map((f) => `event.payload.cause.${f}`),
    ...REDACTED_ANSWER_FIELDS.map((f) => `answer.${f}`),
  ];
}
