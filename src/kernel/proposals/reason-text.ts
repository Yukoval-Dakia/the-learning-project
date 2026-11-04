const UNREADABLE_REASON = '这条提议暂无可读的依据说明，请核实后再决定是否采纳。';

const MASKED_CREDENTIAL = '[已遮蔽凭据]';

// Credential and private-key material is a security boundary, so it is masked in
// place. Everything else (email, URL queries, assignment-shaped text, model
// dump syntax) is the learner's own data and passes through unchanged.
function maskCredentials(text: string): string {
  return text
    .replace(
      /(\b(?:api[-_]?key|password|secret|authorization|access[-_]?token|refresh[-_]?token)\b\s*[=:]\s*)\S+/gi,
      `$1${MASKED_CREDENTIAL}`,
    )
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      MASKED_CREDENTIAL,
    )
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----/g, MASKED_CREDENTIAL)
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, MASKED_CREDENTIAL)
    .replace(
      /\b(?:sk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
      MASKED_CREDENTIAL,
    );
}

/** Reasons pass through as written; only credential material is masked in place. */
export function proposalReasonPlainText(value: unknown): string {
  if (typeof value === 'string') {
    if (!value.trim()) return UNREADABLE_REASON;
    return maskCredentials(value);
  }
  if (value === null || value === undefined) return UNREADABLE_REASON;
  try {
    return maskCredentials(JSON.stringify(value));
  } catch {
    return UNREADABLE_REASON;
  }
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
