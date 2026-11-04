import { z } from 'zod';

const UNREADABLE_REASON = '这条提议暂无可读的依据说明，请核实后再决定是否采纳。';

const MASKED_CREDENTIAL = '[已遮蔽凭据]';

const RecentFailureEvidence = z
  .object({ recent_failure_count_30d: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
  .strict();

function knownEvidence(value: unknown): string | null {
  const parsed = RecentFailureEvidence.safeParse(value);
  return parsed.success
    ? `提议引用的统计中，最近 30 天有 ${parsed.data.recent_failure_count_30d} 条失败作答记录。`
    : null;
}

// Credential and private-key material is a security boundary, so it is masked in
// place. Everything else (email, URL queries, assignment-shaped text, model dump
// syntax) is the learner's own data and passes through unchanged.
const CREDENTIAL_KEY =
  /(?:[A-Za-z0-9]+[-_])*(?:api[-_ ]?key|access[-_]?key|secret[-_]?key|private[-_]?key|client[-_]?secret|password|passwd|pwd|passphrase|authorization|token|secret)(?:[-_][A-Za-z0-9]+)*/
    .source;
// A quoted value is masked to its closing quote, so a space or an escaped quote
// cannot leak a tail. An unclosed quote masks through the end of the text.
const QUOTED_VALUE = /\\"(?:(?!\\").)*(?:\\"|$)|"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)/
  .source;
const BARE_VALUE = /[^\s;,"'`]+/.source;
const ASSIGNED_CREDENTIAL = new RegExp(
  `(\\b${CREDENTIAL_KEY}\\b(?:\\\\?["'])?\\s*[:=]\\s*(?:(?:Bearer|Basic)\\s+)?)(${QUOTED_VALUE}|${BARE_VALUE})`,
  'gis',
);
const AUTH_SCHEME_CREDENTIAL = new RegExp(
  `\\b(?:Bearer|Basic)\\s+(?:${QUOTED_VALUE}|${BARE_VALUE})`,
  'gis',
);

function maskValue(value: string): string {
  const quote = /^(?:\\"|"|')/.exec(value)?.[0];
  return quote ? `${quote}${MASKED_CREDENTIAL}${quote}` : MASKED_CREDENTIAL;
}

function maskCredentials(text: string): string {
  return text
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${MASKED_CREDENTIAL}@`)
    .replace(
      ASSIGNED_CREDENTIAL,
      (_match, prefix: string, value: string) => `${prefix}${maskValue(value)}`,
    )
    .replace(
      // A BEGIN block without a matching END masks through the end of the
      // text; a truncated key body must never reach the learner.
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      MASKED_CREDENTIAL,
    )
    .replace(AUTH_SCHEME_CREDENTIAL, MASKED_CREDENTIAL)
    .replace(
      /\b(?:sk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
      MASKED_CREDENTIAL,
    );
}

// Model-internal reasoning tags never reach the learner: only the tagged span
// is removed, the rest of the reason survives. An unclosed tag masks to the end.
const THINK_BLOCK =
  /<(?:think|thinking|analysis|reasoning)\b[^>]*>[\s\S]*?<\/(?:think|thinking|analysis|reasoning)\s*>/gi;
const THINK_UNCLOSED = /<(?:think|thinking|analysis|reasoning)\b[^>]*>[\s\S]*$/gi;
const THINK_STRAY_CLOSE = /<\/(?:think|thinking|analysis|reasoning)\s*>/gi;

/**
 * Reasons pass through as written; credential material is masked in place and
 * model-internal reasoning tags are stripped. Non-string payloads never render:
 * only the strict known evidence shape translates, anything else falls back to
 * the fixed unreadable sentence.
 */
export function proposalReasonPlainText(value: unknown): string {
  if (typeof value !== 'string') return knownEvidence(value) ?? UNREADABLE_REASON;
  const text = value
    .replace(THINK_BLOCK, '')
    .replace(THINK_UNCLOSED, '')
    .replace(THINK_STRAY_CLOSE, '');
  if (!text.trim()) return UNREADABLE_REASON;
  return maskCredentials(text);
}

/** Raw reason copies in legacy payloads must not bypass the public read mapping. */
export function mapProposalReasonFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(mapProposalReasonFields);
  if (typeof value !== 'object' || value === null) return value;
  const entries: Array<[string, unknown]> = Object.entries(value);
  return Object.fromEntries(
    entries.map(([key, item]) => [
      key,
      key === 'reason_md' || key === 'reasoning' || key === 'reason' || key === 'archived_reason'
        ? proposalReasonPlainText(item)
        : mapProposalReasonFields(item),
    ]),
  );
}
