// Learner-facing proposal summaries are a product boundary: internal ids, tool
// names, and English field names must stop at the write boundary. This module is
// the single deterministic gate — pattern matching only, no AI review, no scoring.
//
// What stays allowed: math notation with a short subscript (`v_0`, `v_t`, `a_n`,
// `x_1`, `log_2`, `CO_2`, `x_max`, `v_max`), one-letter assignments (`x=2`, `n=1`),
// uppercase-start assignments (`AB=CD`, `pH=7`, `Ka=1.8`), function forms (`f(x)`),
// ordinary English words (`pH`, `DNA`, `Python`), and Chinese prose.
//
// Known false positives (误拦): a snake_case English term (`self_attention`,
// `for_each`, `base_case`), a multi-letter camelCase word (`myVar`), and a
// lowercase function name in assignment form (`sin=0.5`) are rejected; the
// producer should rewrite them as plain Chinese. We accept this over-blocking
// because those tokens are indistinguishable from schema field / tool names.
//
// Known false negatives (漏拦): camelCase field names inside Chinese prose are
// caught only when they start lowercase (`queryKnowledge`), bare English words
// outside the short structural list below, short opaque ids (<20 chars without a
// prefix), and an all-English summary. The UI's id-chip fallback
// (`splitReasonIds`) still de-emphasizes id-shaped tokens that reach a card, and
// the schema cap keeps the line short.

import { LEARNER_SUMMARY_MAX_CHARS } from '@/core/schema/proposal';

export type LearnerSummaryViolationRule = 'opaque_id' | 'tool_or_field_name' | 'field_assignment';

export interface LearnerSummaryViolation {
  rule: LearnerSummaryViolationRule;
  match: string;
}

// Short math subscripts are subject notation, not field names. `v_0` / `log_2` /
// `CO_2` are `<letters>_<digits>`, and a single-letter base takes any short
// subscript (`v_t`, `a_n`, `x_max`, `v_max`).
const MATH_SUBSCRIPT = /^[A-Za-z]+_\d+$/;
const SINGLE_LETTER_SUBSCRIPT = /^[A-Za-z]_[A-Za-z0-9]+$/;

function isMathNotation(token: string): boolean {
  return MATH_SUBSCRIPT.test(token) || SINGLE_LETTER_SUBSCRIPT.test(token);
}

interface MatchRule {
  rule: LearnerSummaryViolationRule;
  pattern: RegExp;
  /** Rule-specific exclusions (math notation, one-letter operands). */
  accept?: (match: RegExpMatchArray) => boolean;
}

// Raw ids use the same shape the UI's id-chip splitter recognizes
// (`RAW_ID_RE` in src/capabilities/shell/ui/inbox-api.ts): block-<cuid>, a
// namespaced id, or any 20+ run of lowercase alphanumerics (40-char hex and
// hyphenless UUIDs). Hyphenated UUIDs are matched explicitly because the UI
// regex leaves their segments too short.
const HYPHENATED_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const RAW_ID = /\b(?:block-[a-z0-9]{12,}|[a-z]+:[a-z0-9:_-]{8,}|[a-z0-9]{20,})\b/g;

// Any multi-letter all-lowercase `field=value` form is a leak; the field name is
// not limited to an allowlist, so `id=`, `weight=`, `op=`, `domain=`, `status=`
// all match. One-letter math operands (`x=2`, `n=1`), uppercase-start names
// (`AB=CD`, `pH=7`, `Ka=1.8`), and math subscripts (`x_max=`) stay out.
const FIELD_ASSIGNMENT = /\b([a-z][a-z0-9_]*)\s*=\s*[^\s，。；、,;）)]+/g;

// Snake_case identifiers, case-insensitive so `Propose_Knowledge_Edge` is caught
// like `propose_knowledge_edge`; math subscripts are excluded above.
const SNAKE_TOKEN = /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g;
// Lowercase-start camelCase (`queryKnowledge`). `pH` stays allowed because it has
// only one lowercase letter before the capital.
const CAMEL_TOKEN = /\b[a-z]{2,}[A-Z][A-Za-z0-9]*\b/g;
// Bare structural words that are never learner copy; assignments already carry
// their `field=value` spelling.
const BARE_FIELD_WORD = /\b(?:children|edges|payload|metadata)\b/gi;

const MATCH_RULES: readonly MatchRule[] = [
  {
    rule: 'field_assignment',
    pattern: FIELD_ASSIGNMENT,
    accept: (match) => {
      const field = match[1] ?? '';
      return field.length >= 2 && !isMathNotation(field);
    },
  },
  { rule: 'opaque_id', pattern: HYPHENATED_UUID },
  { rule: 'opaque_id', pattern: RAW_ID },
  {
    rule: 'tool_or_field_name',
    pattern: SNAKE_TOKEN,
    accept: (match) => !isMathNotation(match[0]),
  },
  { rule: 'tool_or_field_name', pattern: CAMEL_TOKEN },
  { rule: 'tool_or_field_name', pattern: BARE_FIELD_WORD },
];

const MAX_REPORTED_VIOLATIONS = 5;

/** Matches in first-occurrence order, deduped by span, capped for a short retry message. */
export function findLearnerSummaryViolations(text: string): LearnerSummaryViolation[] {
  const violations: LearnerSummaryViolation[] = [];
  const covered: Array<[number, number]> = [];
  for (const spec of MATCH_RULES) {
    for (const match of text.matchAll(new RegExp(spec.pattern.source, spec.pattern.flags))) {
      if (spec.accept && !spec.accept(match)) continue;
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

/**
 * Deterministic producer-side line: omit it instead of failing the proposal when
 * the candidate trips the same gate the writer applies (or the schema cap). The
 * card then falls back to the fixed per-kind sentence.
 */
export function learnerSummaryIfAllowed(candidate: string): string | undefined {
  const value = candidate.trim();
  if (value.length === 0 || value.length > LEARNER_SUMMARY_MAX_CHARS) return undefined;
  return findLearnerSummaryViolations(value).length === 0 ? value : undefined;
}
