import { sha256Hex } from './canonical';
import type { MigrationCapture, RawEventRow } from './types';

// ====================================================================
// YUK-1048 — 捕获脱敏（grounding §14 manifest 的 redacted flags 支撑）
// ====================================================================
//
// D19 census 纪律是「无原始 learner 内容」；cutover 捕获默认需要原文保真
// （迁移对账要 body），但工具必须支持 --redact 产出可外发的脱敏工件。
//
// 按【实际捕获的事件变体】的文本字段做深.walk 键名匹配（review P1-6）：
//   - 作答文本：answer_md / user_response_md / response_md（durable pending
//     的 submit.body 内）/ wrong_answer_md / reasoning_trace
//   - 模型输出自由文本：cause.analysis_md / judge.feedback_md /
//     rejudge_raw_output
//   - 纠正理由：reason_md（correct 事件，可能含 learner 上下文）
// 深.walk 覆盖嵌套对象/数组（submit.body、embedded judge 块等），只替换
//【字符串值】，结构与分类 marker（source/unsupported_judge/judge_route/
// question_snapshot 等）原样保留 —— 脱敏后分类结果不变（单测钉死）。
// 题面（prompt_md/question_snapshot）是题面内容不是 learner 内容，按 census
// 策略保留。

/** 被替换文本的占位形状（types.ts RedactedTextPlaceholder）。 */
export interface RedactedText {
  __redacted: true;
  sha256: string;
  length: number;
}

/** 深.walk 命中即脱敏的字符串字段名（跨事件变体共用）。 */
export const REDACTED_STRING_KEYS = [
  'answer_md',
  'user_response_md',
  'response_md',
  'wrong_answer_md',
  'reasoning_trace',
  'analysis_md',
  'feedback_md',
  'rejudge_raw_output',
  'reason_md',
] as const;

/** manifest.redaction.fields 的规范清单（与实现一一对应）。 */
export function redactedFieldList(): string[] {
  return [
    ...REDACTED_STRING_KEYS.map((f) => `event.payload..${f}`),
    'answer.content_md',
    'answer.vision_extracted',
  ];
}

function redactText(value: string): RedactedText {
  return {
    __redacted: true,
    sha256: sha256Hex(value),
    length: value.length,
  };
}

/**
 * 深度键名匹配脱敏：递归遍历对象/数组，凡 own key ∈ REDACTED_STRING_KEYS 且
 * 值为 string ⇒ 替换为占位。返回新结构（输入不可变）；非字符串值（数字/
 * 对象/数组）原样保留。
 */
export function redactDeepByKey(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactDeepByKey);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const entry = record[key];
      out[key] =
        typeof entry === 'string' && (REDACTED_STRING_KEYS as readonly string[]).includes(key)
          ? redactText(entry)
          : redactDeepByKey(entry);
    }
    return out;
  }
  return value;
}

/**
 * 返回脱敏后的新 capture（原对象不可变）。清单记录 redaction.applied，
 * 哈希覆盖的是脱敏后形态 —— 同一 DB 状态在固定脱敏模式下哈希仍稳定。
 */
export function redactMigrationCapture(capture: MigrationCapture): MigrationCapture {
  const events: RawEventRow[] = capture.rawFacts.events.map((e) => ({
    ...e,
    payload: redactDeepByKey(e.payload),
  }));
  return {
    ...capture,
    rawFacts: {
      ...capture.rawFacts,
      events,
      answers: capture.rawFacts.answers.map((answer) => ({
        ...answer,
        content_md:
          typeof answer.content_md === 'string' ? redactText(answer.content_md) : answer.content_md,
        vision_extracted:
          typeof answer.vision_extracted === 'string'
            ? redactText(answer.vision_extracted)
            : answer.vision_extracted,
      })),
    },
  };
}
