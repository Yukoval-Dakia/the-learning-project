// YUK-1408 (Stage 1 B6 S1) — ingestion privacy guard.
//
// Two deterministic mechanisms, no model in the loop:
//
//   1. `redactIngestionText` — personal-identifier redaction applied to
//      extracted text BEFORE it is sent to a model. Field categories mirror
//      the display-side detector list landed in #1701 (credential syntax,
//      emails, labeled contact fields) plus document-context identity fields
//      (labeled identity rows, teacher-contact labels, ranking labels). Only
//      label-anchored or format-strong spans are rewritten — free-running
//      Chinese names inside question prose are deliberately NOT touched so
//      legitimate content (word problems like 「小明有3个苹果」) is never
//      damaged.
//   2. Usage receipt — `writeIngestionUsageReceipt` records on the
//      source_document WHAT was redacted under WHICH policy version
//      (categories and channels only, never the redacted values). The policy
//      resolvers live in `src/kernel/read-models/usage-policy.ts` (shared read
//      layer — kernel events consume them too) so the existing derivation filter
//      (src/kernel/events/derivation-policy.ts) drops them from memory/brief
//      channels when consent is withdrawn. No second mechanism.
//
// Page images sent to OCR/VLM engines cannot be text-redacted; the receipt
// records that channel honestly as `raw`.

import { newId } from '@/core/ids';
import type { DerivationPolicyT } from '@/core/schema/derivation-policy';
import type { Db, Tx } from '@/db/client';
import { writeEvent } from '@/kernel/events';

/** Bump when the field set or replacement contract changes; receipts pin this. */
export const INGESTION_PRIVACY_POLICY_VERSION = 'ingestion-privacy-v1';

/** Fixed replacement marker. Readable inside Chinese model prompts. */
const REDACTED = '[已隐去]';

/**
 * The personal-identifier categories this guard can redact. The list is the
 * receipt vocabulary: a receipt records WHICH categories fired, never values.
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

// Label-anchored rules keep the label and redact only the value span. The
// value run stops at whitespace, common CJK punctuation, or line end so a
// following sentence is preserved; parens stay INSIDE the value so class
// names like 「初三(2)班」 redact whole.
const LABELED_VALUE = String.raw`[^\s,，。;；:：、<>《》「」]{1,64}`;

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
      String.raw`(?:api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|密码|密钥)\s*[=:：]\s*${LABELED_VALUE}`,
      'gi',
    ),
  },
  { field: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  // Mainland mobile numbers. Format-strong, no label required.
  { field: 'phone', pattern: /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g },
  {
    field: 'phone',
    pattern: /((?:电话|手机|联系电话|联系方式|家长电话|热线)\s*[:：]?\s*)\+?\d[\d\s-]{5,19}\d/g,
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
  // Ranking is only redacted behind an explicit ranking label — bare 「第5名」
  // inside problem prose is legitimate content and must survive.
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
}

/**
 * Deterministically redact personal identifiers from extracted text. Idempotent:
 * re-running on redacted output is a no-op (the marker matches no rule).
 */
export function redactIngestionText(text: string): IngestionRedactionResult {
  const fired = new Set<IngestionRedactionField>();
  let out = text;
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    out = out.replace(rule.pattern, (_match, label?: string) => {
      fired.add(rule.field);
      // Labeled rules capture the label in group 1 and keep it.
      return typeof label === 'string' ? `${label}${REDACTED}` : REDACTED;
    });
  }
  return { text: out, fields: [...fired].sort() };
}

export interface IngestionUsageReceipt {
  sourceDocumentId: string;
  sessionId: string;
  /** The derivation policy the document's content was sent under. */
  derivationPolicy: DerivationPolicyT;
  /** OCR engine that ran ('glm' | 'tencent') — receipt self-describing. */
  engine: string;
  /** Categories that actually fired on the extraction text this run. */
  redactedFields: IngestionRedactionField[];
  now?: Date;
}

/**
 * Write the per-extraction usage receipt on the source document. The payload
 * records the policy + which categories were redacted + which channels carried
 * raw vs redacted content — never the redacted values themselves. When the
 * document is consented `answer_only`, the receipt itself inherits that policy
 * so it stays out of derivation channels like every other derived record.
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
      channels: {
        // OCR/VLM engines must see the raw page image to extract at all; only
        // extracted text is redacted before model calls.
        page_images: 'raw',
        extracted_text: 'redacted',
      },
      redacted_fields: input.redactedFields,
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: input.now,
  });
  return id;
}
