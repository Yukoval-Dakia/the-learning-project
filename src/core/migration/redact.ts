import { sha256Hex } from './canonical';
import type { MigrationCapture, RawEventRow } from './types';

// ====================================================================
// YUK-1048 — 捕获脱敏（grounding §14；review 终轮 P1-4：默认拒绝）
// ====================================================================
//
// 完整 event 分区捕获带进了全部事件家族（copilot 对话、record capture、
// 知识 propose……），一张 denylist 不可能穷举私有文本键。策略反转：
//
//   【默认拒绝】event.payload 内所有未列入 SAFE_STRING_KEYS 的字符串值
//   一律脱敏（深.walk：嵌套对象/数组；数组内的【标量】元素继承父属性键
//   策略 —— 安全键数组（id/枚举）整体保留，非安全键数组（warnings /
//   failure_reasons 等自由文本 string[]）逐元素脱敏；对象元素按自身键
//   判定）；数字/布尔/对象结构原样。已知结构性子树
//   （question_snapshot —— 题面内容非 learner 内容，且分类器要验形状）
//   整棵保留。
//
//   SAFE_STRING_KEYS 只收：id/引用、枚举/标记（分类 marker）、时间戳、
//   受控词汇键。新增事件家族缺省安全（新文本键自动被脱敏），新增 marker
//   需显式登记（分类器只读 marker —— 测试钉死脱敏后分类不变）。

/** 被替换文本的占位形状（types.ts RedactedTextPlaceholder）。 */
export interface RedactedText {
  __redacted: true;
  sha256: string;
  length: number;
}

/** 永不脱敏的字符串键（id/枚举/标记/时间戳/受控词汇）。 */
export const SAFE_STRING_KEYS = [
  // id / 引用
  'id',
  'run_id',
  'question_id',
  'subject_id',
  'session_id',
  'event_id',
  'attempt_event_id',
  'origin_event_id',
  'source_event_id',
  'task_run_id',
  'caused_by_event_id',
  'replacement_event_id',
  'stream_item_id',
  'paper_artifact_id',
  'artifact_id',
  'learning_item_id',
  'anchor_event_id',
  'materialized_id',
  'ref_kind',
  'ref_id',
  'parent_question_id',
  'root_question_id',
  'parent_variant_id',
  'knowledge_id',
  'kc_id',
  'cooldown_key',
  // 枚举 / 标记（分类 marker —— 登记即受测试保护）
  'action',
  'actor_kind',
  'actor_ref',
  'subject_kind',
  'outcome',
  'status',
  'kind',
  'type',
  'source',
  'caller',
  'route',
  'judge_route',
  'coarse_outcome',
  'score_meaning',
  'correction_kind',
  'lifecycle',
  'provenance',
  'track',
  'capture_mode',
  'activity_kind',
  'processing_status',
  'fsrs_rating',
  'fsrs_subject_kind',
  'typed_state',
  'schema_version',
  'reconstruction_signal',
  'surface',
  'generated_by',
  'enroll_outcome',
  'record_kind',
  'state',
  'role',
  'trigger',
  'policy',
  'chip_kind',
  // 时间戳 / 版本
  'submitted_at',
  'updated_at',
  'created_at',
  'due_at',
  'started_at',
  'ended_at',
  'last_review',
  'decided_at',
  'date',
  'version',
  'question_version',
  'generation',
] as const;

/** 整棵保留的结构性子树键（不深入、不脱敏）。 */
export const SAFE_SUBTREE_KEYS = [
  // 题面冻结快照：题面内容非 learner 内容，分类器需原形状做契约校验。
  'question_snapshot',
  // FSRS 状态对象（纯调度状态，无自由文本）。
  'fsrs_state_after',
  'fsrs_state_after_by_subject',
] as const;

/** manifest.redaction.fields 的规范描述（与实现一一对应）。 */
export function redactedFieldPolicy(): {
  policy: string;
  safe_string_keys: string[];
  safe_subtree_keys: string[];
} {
  return {
    policy:
      'default-deny: event.payload 内所有未列入 safe_string_keys 的字符串值（含嵌套对象）一律脱敏；数组标量元素继承父键策略（safe_string_keys 数组保留、其余 string[] 逐元素脱敏）；safe_subtree_keys 子树整棵保留；数字/布尔/对象结构原样',
    safe_string_keys: [...SAFE_STRING_KEYS],
    safe_subtree_keys: [...SAFE_SUBTREE_KEYS],
  };
}

function redactText(value: string): RedactedText {
  return {
    __redacted: true,
    sha256: sha256Hex(value),
    length: value.length,
  };
}

/**
 * 深度默认拒绝脱敏：递归遍历对象；safe subtree 键整棵保留；字符串值仅当
 * 键 ∈ SAFE_STRING_KEYS 时保留，否则替换为占位。数组逐元素递归并把父属性键
 * 下传 —— 标量元素按父键策略判定（YUK-1098：warnings/failure_reasons 这类
 * 自由文本 string[] 必须被脱敏，safe 键的 id/枚举 string[] 仍整体保留）；
 * 对象元素按自身键判定。返回新结构，输入不可变。
 */
export function redactDeepByKey(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((element) => redactDeepByKey(element, key));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const record = value as Record<string, unknown>;
    for (const childKey of Object.keys(record)) {
      const entry = record[childKey];
      if ((SAFE_SUBTREE_KEYS as readonly string[]).includes(childKey)) {
        out[childKey] = entry;
        continue;
      }
      out[childKey] = redactDeepByKey(entry, childKey);
    }
    return out;
  }
  if (
    typeof value === 'string' &&
    key !== undefined &&
    !(SAFE_STRING_KEYS as readonly string[]).includes(key)
  ) {
    return redactText(value);
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
