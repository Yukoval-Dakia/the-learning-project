// Learner-facing proposal summaries are a product boundary: the inbox card and the
// "what I just did" digest render them verbatim, so internal ids, tool names, and
// English field names must stop at the write boundary. This module is the single
// deterministic gate — pattern matching only, no AI review, no scoring.
//
// Known false positives (误拦): a summary that legitimately needs a snake_case
// English token (e.g. a subject term written as `self_attention`) or a 24-char
// lowercase token is rejected; the producer should rewrite it as plain Chinese
// prose. Single-letter math assignments such as `x=0` are not matched because the
// field-name list is explicit.
//
// Known false negatives (漏拦): camelCase field names (`knowledgeIds`), bare
// English words outside the explicit list (`parent`), short opaque ids (<20 chars
// without a prefix), and an all-English summary pass. The UI's id-chip fallback
// (`splitReasonIds`) still de-emphasizes id-shaped tokens that do reach a card,
// and the schema cap keeps the line short.

export type LearnerSummaryViolationRule = 'opaque_id' | 'tool_or_field_name' | 'field_assignment';

export interface LearnerSummaryViolation {
  rule: LearnerSummaryViolationRule;
  match: string;
}

interface ViolationSpec {
  rule: LearnerSummaryViolationRule;
  pattern: string;
  flags: string;
}

// Assignment forms are checked first so `children=0` reports the whole form
// instead of also reporting the bare word `children`.
const VIOLATION_SPECS: readonly ViolationSpec[] = [
  {
    rule: 'field_assignment',
    pattern:
      '\\b(?:children|edges|version|reasoning|payload|metadata|kind|mutation|target|count|parent|name)\\s*=\\s*[^\\s，。；、,;）)]+',
    flags: 'gi',
  },
  {
    rule: 'opaque_id',
    // UUID (any version), block-<cuid>, cuid2 (exactly 24 lowercase alnum), and
    // namespaced ids such as `synthetic:yuwen:...`.
    pattern:
      '\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b|\\bblock-[a-z0-9]{12,}\\b|\\b[a-z][a-z0-9]{23}\\b|\\b[a-z]+:[a-z0-9:_-]{8,}\\b',
    flags: 'gi',
  },
  {
    rule: 'tool_or_field_name',
    // Any snake_case identifier is a tool name (`propose_knowledge_edge`), a
    // mutation branch (`propose_new`), or a schema field (`evidence_event_ids`).
    pattern: '\\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\\b|\\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\\b',
    flags: 'g',
  },
  {
    rule: 'tool_or_field_name',
    // Bare structural words that are never learner copy (the `=value` forms above
    // already cover their assignment spelling).
    pattern: '\\b(?:children|edges|payload|metadata|proposed_change)\\b',
    flags: 'gi',
  },
];

const MAX_REPORTED_VIOLATIONS = 5;

/** Matches in first-occurrence order, deduped by span, capped for a short retry message. */
export function findLearnerSummaryViolations(text: string): LearnerSummaryViolation[] {
  const violations: LearnerSummaryViolation[] = [];
  const covered: Array<[number, number]> = [];
  for (const spec of VIOLATION_SPECS) {
    for (const match of text.matchAll(new RegExp(spec.pattern, spec.flags))) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (covered.some(([from, to]) => start < to && end > from)) continue;
      covered.push([start, end]);
      violations.push({ rule: spec.rule, match: match[0] });
      if (violations.length >= MAX_REPORTED_VIOLATIONS) return violations;
    }
  }
  return violations;
}

const RULE_LABEL: Record<LearnerSummaryViolationRule, string> = {
  opaque_id: '内部 id',
  tool_or_field_name: '工具名或英文字段名',
  field_assignment: '英文字段赋值',
};

/**
 * Thrown from the write boundary so the producing model sees a precise,
 * retryable error: only the learner-facing sentence is wrong, everything else in
 * the call can stay as-is.
 */
export class LearnerSummaryRejectedError extends Error {
  readonly violations: readonly LearnerSummaryViolation[];

  constructor(violations: readonly LearnerSummaryViolation[]) {
    const samples = violations
      .slice(0, 3)
      .map((violation) => `"${violation.match}"（${RULE_LABEL[violation.rule]}）`)
      .join('、');
    super(
      `learner_summary_rejected: learner_summary 只能写一句给学习者看的「做了什么、为什么」，但出现了 ${samples}。` +
        '请删掉内部 id、工具名和英文字段名，只改写这一句后重试；change / reasoning / evidence 保持不动。',
    );
    this.name = 'LearnerSummaryRejectedError';
    this.violations = violations;
  }
}

/** Optional by contract: proposals written before the field existed stay valid. */
export function assertLearnerSummaryAllowed(value: string | undefined): void {
  if (value === undefined) return;
  const violations = findLearnerSummaryViolations(value);
  if (violations.length > 0) throw new LearnerSummaryRejectedError(violations);
}
