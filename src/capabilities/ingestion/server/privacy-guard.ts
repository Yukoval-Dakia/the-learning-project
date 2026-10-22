// Ingestion privacy guard: deterministic, no model in the loop.
//
// Redaction rewrites only label-anchored or format-strong spans, so names inside
// question prose are never damaged. Usage receipts record categories and channels,
// never values, under the shared policy resolvers so a consent withdrawal also
// excludes them from memory and brief channels. Page images cannot be redacted;
// receipts record that channel honestly as raw.

import { newId } from '@/core/ids';
import type { DerivationPolicyT } from '@/core/schema/derivation-policy';
import type { Db, Tx } from '@/db/client';
import { writeEvent } from '@/kernel/events';

/** Bump when the field set or replacement contract changes; receipts pin this. */
export const INGESTION_PRIVACY_POLICY_VERSION = 'ingestion-privacy-v1';

/** Fixed replacement marker. Readable inside Chinese model prompts. */
const REDACTED = '[已隐去]';

/**
 * Redactable categories, also the receipt vocabulary. Receipts record fired
 * categories, never values.
 */
export type IngestionRedactionField =
  | 'phone' // 手机号 / labeled 电话·手机 numbers
  | 'email'
  | 'id_number' // 身份证 / 学号 / 考号 / 准考证号 (labeled or 18-digit)
  | 'labeled_identity' // 姓名/学校/班级/学号 labeled values
  | 'labeled_contact' // 电话/微信/QQ/地址/班主任 labeled values
  | 'ranking' // 班级排名/年级排名/名次 labeled values
  | 'credential'; // api keys / tokens / private keys (mirrors #1701 detectors)

type RedactionRule = {
  field: IngestionRedactionField;
  pattern: RegExp;
};

// Label-anchored rules keep the label and redact only the value. The value stops
// at whitespace, CJK punctuation, or an adjacent label; parentheses stay inside so
// a class name redacts whole.
const LABEL_BOUNDARY = `(?:姓名|学生姓名|考生姓名|名字|就读学校|所在学校|学校|班级|班别|考区|考点|校长|家长姓名|监护人|班主任|任课老师|任课教师|指导老师|辅导员|邮箱|微信号?|QQ号?|qq号?|住址|家庭住址|通讯地址|联系地址|紧急联系人|电话|手机|联系电话|联系方式|家长电话|热线|身份证号?|证件号|学号|考号|准考证号|学籍号|班级排名|年级排名|全校排名|综合排名|排名|名次|年级名次|班级名次|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|密码|密钥)`;
const LABELED_VALUE = String.raw`(?:(?!${LABEL_BOUNDARY}\s*[:：])[^\s,，。;；:：、<>《》「」]){1,64}`;

const RULES: RedactionRule[] = [
  {
    field: 'credential',
    pattern:
      /\b(?:sk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
  },
  {
    field: 'credential',
    pattern: /-----BEGIN [^-]*PRIVATE KEY-----/g,
  },
  {
    field: 'credential',
    pattern: new RegExp(
      String.raw`((?:api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|密码|密钥)\s*[=:：]\s*)${LABELED_VALUE}`,
      'gi',
    ),
  },
  { field: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  // Only separator-marked mobile numbers; a bare 11-digit run can be an arithmetic
  // operand. Labeled digits are handled by the labeled rule.
  {
    field: 'phone',
    pattern: /(?<![\d-])(?:\+?86[-\s])?1[3-9]\d[-\s]\d{4}[-\s]\d{4}(?!\d)/g,
  },
  {
    field: 'phone',
    pattern:
      /((?:手机号?码?|电话号?码?|联系电话|联系方式|家长电话|热线|Tel|tel|TEL)\s*(?:是)?\s*[:：]?\s*)\+?\d[\d\s-]{5,19}\d/g,
  },
  // Chinese 18-digit resident ID (final char may be X). Format-strong.
  { field: 'id_number', pattern: /(?<![\dA-Za-z])\d{17}[\dXx](?![\dA-Za-z])/g },
  {
    field: 'id_number',
    pattern: new RegExp(
      String.raw`((?:身份证(?:号|号码)?|证件号|学号|考号|准考证号|学籍号)\s*[:：]?\s*)${LABELED_VALUE}`,
      'g',
    ),
  },
  {
    field: 'labeled_identity',
    pattern: new RegExp(
      String.raw`((?:姓名|学生姓名|考生姓名|名字|就读学校|所在学校|学校|班级|班别|考区|考点|校长|家长姓名|监护人)\s*[:：]\s*)${LABELED_VALUE}`,
      'g',
    ),
  },
  {
    field: 'labeled_contact',
    pattern: new RegExp(
      String.raw`((?:班主任|任课老师|任课教师|指导老师|辅导员|邮箱|微信号?|QQ号?|qq号?|住址|家庭住址|通讯地址|联系地址|紧急联系人)\s*[:：]\s*)${LABELED_VALUE}`,
      'g',
    ),
  },
  // Bare 「第5名」 is legitimate problem content; only labeled rankings redact.
  {
    field: 'ranking',
    pattern:
      /((?:班级排名|年级排名|全校排名|综合排名|排名|名次|年级名次|班级名次)\s*[:：]?\s*)第?\s*\d+\s*名?/g,
  },
];

export interface IngestionRedactionResult {
  text: string;
  /** Sorted unique categories that fired. Empty when nothing was redacted. */
  fields: IngestionRedactionField[];
  /**
   * Mutated-span counts make silent degradation visible as an unexplained zero.
   * Numbers only; values are never recorded.
   */
  counts: Partial<Record<IngestionRedactionField, number>>;
}

/**
 * Redacts personal identifiers from extracted text. Idempotent: the marker matches
 * no rule, so re-running changes nothing.
 */
export function redactIngestionText(text: string): IngestionRedactionResult {
  const fired = new Map<IngestionRedactionField, number>();
  let out = text;
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    out = out.replace(rule.pattern, (_match, label?: string) => {
      fired.set(rule.field, (fired.get(rule.field) ?? 0) + 1);
      // Labeled rules capture the label in group 1 and keep it.
      return typeof label === 'string' ? `${label}${REDACTED}` : REDACTED;
    });
  }
  return {
    text: out,
    fields: [...fired.keys()].sort(),
    counts: Object.fromEntries(fired) as Partial<Record<IngestionRedactionField, number>>,
  };
}

export interface IngestionUsageReceipt {
  sourceDocumentId: string;
  sessionId: string;
  /** The derivation policy the document's content was sent under. */
  derivationPolicy: DerivationPolicyT;
  /** Engine that ran, so the receipt is self-describing. */
  engine: string;
  /** Categories that actually fired on the extraction text this run. */
  redactedFields: IngestionRedactionField[];
  /** Mutated-span count per category; never values. */
  redactionCounts?: Partial<Record<IngestionRedactionField, number>>;
  /** Recovery cannot reconstruct an in-memory sink after rollback/crash. */
  redactionAccounting?: 'unavailable';
  /**
   * Per-path channel accounting. OCR sends raw images plus redacted text; the DOCX
   * text line sends no images and redacts at call sites. 'none' means the channel
   * never left the server. Defaults to the OCR/VLM shape.
   */
  channels?: {
    page_images: 'raw' | 'none';
    extracted_text: 'redacted' | 'none';
  };
  /**
   * Per-segment receipt: a suspended segment's paid work and redactions are usage
   * too. Absent for single-shot OCR lanes.
   */
  segment?: number;
  now?: Date;
}

/**
 * Records policy, redacted categories, and channels on the source document, never
 * values. An answer_only document's receipt inherits that policy and stays out of
 * derivation channels.
 */
export async function writeIngestionUsageReceipt(
  db: Db | Tx,
  input: IngestionUsageReceipt,
): Promise<string> {
  const id = newId();
  await writeEvent(db, {
    id,
    session_id: input.sessionId,
    actor_kind: 'system',
    actor_ref: 'ingestion_privacy_guard',
    action: 'experimental:ingestion_usage_receipt',
    subject_kind: 'source_document',
    subject_id: input.sourceDocumentId,
    outcome: 'success',
    payload: {
      policy_version: INGESTION_PRIVACY_POLICY_VERSION,
      derivation_policy: input.derivationPolicy,
      engine: input.engine,
      channels: input.channels ?? {
        // Engines need the raw page image; only extracted text is redacted.
        page_images: 'raw',
        extracted_text: 'redacted',
      },
      redacted_fields: input.redactionAccounting ? null : input.redactedFields,
      redaction_counts: input.redactionAccounting ? null : (input.redactionCounts ?? {}),
      ...(input.redactionAccounting ? { redaction_accounting: input.redactionAccounting } : {}),
      ...(input.segment !== undefined ? { segment: input.segment } : {}),
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: input.now,
  });
  return id;
}
