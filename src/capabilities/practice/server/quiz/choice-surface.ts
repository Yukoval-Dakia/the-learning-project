// Deterministic choice/answer-surface rules. Pure: no I/O or DB/provider/blob edges; do not
// add paid calls or persistence here.
// answerCandidates normalizes label wrappers, option bodies, punctuation variants, rubric
// reference solutions, and first-line fallbacks. evaluateChoiceSurface and runSolveCheck
// share that kernel. choiceSurfacePrecheck rejects insufficient, duplicate, or
// reference-not-in-choices surfaces before any paid verify call.

import { normalizeToCanonicalKind } from '@/subjects/question-kind';

/**
 * Question fields the reference-answer candidate expansion reads. Both callers
 * (evaluateChoiceSurface here; runSolveCheck in verify-framework.ts) pass their
 * full question objects — the field types match the original
 * Pick<SolveCheckQuestion, 'reference_md' | 'rubric_json' | 'choices_md'>
 * exactly, kept structural so this module adds no import edge back.
 */
interface ReferenceAnswerSource {
  reference_md: string | null;
  rubric_json: unknown;
  choices_md: string[] | null;
}

// the question's declared answer for solve-check comparison. reference-solution.ts
// writes the STRUCTURED final answer to rubric_json.reference_solution.final_answer
// (+ answer_equivalents) while reference_md holds the full worked solution prose.
// Comparing an exact solver answer against an entire worked solution would falsely
// fail, so prefer the structured final answer and only fall back to reference_md when
// no structured answer is present.
// A1 (独立 review) — the reference_md fallback is the COMMON case for quiz_gen rows:
// quiz_gen writes reference_md + rubric_json{keywords,required_points} but NO
// reference_solution, and both backfill paths gate on reference_md IS NULL (quiz_gen rows
// are always non-null → never backfilled). An exact-kind quiz_gen reference_md is typically
// 「答案+解析」 prose, so the whole-text candidate alone made normalize-compare a
// near-guaranteed false FAIL. Mitigation: ALSO derive (a) the first LINE and (b) the first
// SENTENCE of that line (split on full-width enders 。！？ only — ASCII '.' excluded so
// decimals like "3.14" never truncate) as candidates; the quiz_gen prompt contract puts the
// bare answer first (choice/true_false: correct option text). Reverse (false-pass) risk: a
// solver final_answer would have to normalize-equal a NON-answer prose line — implausible
// for exact-shaped rows (the exact path is already gated to the objective kind family
// persisted choices / judge='exact'), and a rare false pass merely reproduces the pre-solve-check status quo,
// vs. the certain false FAIL today. Whole-text candidate kept (multi-candidate `.includes`
// = any hit passes); candidate[0] stays the whole text so the semantic path's reference is
// unchanged. No kind gate — spec 附录 B (review A1 裁决).
export function referenceAnswerCandidates(q: ReferenceAnswerSource): string[] {
  const rubric = q.rubric_json;
  if (rubric !== null && typeof rubric === 'object' && !Array.isArray(rubric)) {
    const refSolution = (rubric as Record<string, unknown>).reference_solution;
    if (refSolution !== null && typeof refSolution === 'object' && !Array.isArray(refSolution)) {
      const rs = refSolution as Record<string, unknown>;
      const out: string[] = [];
      if (typeof rs.final_answer === 'string' && rs.final_answer.trim().length > 0) {
        out.push(rs.final_answer.trim());
      }
      if (Array.isArray(rs.answer_equivalents)) {
        for (const eq of rs.answer_equivalents) {
          if (typeof eq === 'string' && eq.trim().length > 0) out.push(eq.trim());
        }
      }
      if (out.length > 0) return out;
    }
  }
  const fallback = (q.reference_md ?? '').trim();
  if (fallback.length === 0) return [];
  const out = [fallback];
  // A1 — first line of the worked answer (quiz_gen contract: bare answer first).
  const firstLine = (fallback.split(/\r?\n/, 1)[0] ?? '').trim();
  if (firstLine.length > 0 && firstLine !== fallback) out.push(firstLine);
  // A1 — first sentence of that line (full-width enders only; '.' excluded for decimals).
  const firstSentence = (firstLine.split(/[。！？]/u, 1)[0] ?? '').trim();
  if (firstSentence.length > 0 && !out.includes(firstSentence)) out.push(firstSentence);
  return out;
}

export function normalizeAnswer(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s　]+/gu, '') // strip ASCII + full-width whitespace only
    .trim();
}

function choiceLabelIndex(value: string): number | null {
  // Wrapper forms「（C）」/「【C】」are legal label shapes (sourcing contract),
  // so strip label wrappers before the bare-letter test. NFKC already folds
  // fullwidth ；【】 survives it, hence both sets here.
  const label = value
    .normalize('NFKC')
    .replace(/^[\s([【]+|[\s)\]】]+$/gu, '')
    .trim()
    .toUpperCase();
  if (!/^[A-F]$/u.test(label)) return null;
  return label.charCodeAt(0) - 'A'.charCodeAt(0);
}

/**
 * Single shape parser for a label-prefixed reference: returns the option the
 * label points at plus the remainder text, or null when the value is not
 * label-prefixed (bare labels carry no remainder and also return null —
 * choiceLabelIndex resolves those).
 *
 * A label is a letter followed by a DELIMITER (a bracket wrapper, `.` `、`
 * `：` etc., or whitespace) — never by a Han character: an option body like
 * `C语言` starts with A–F + Han, and stripping it would both reject valid
 * items (the whole text no longer matches its own option) and mint a false
 * solve-check candidate that can grade a wrong answer as correct
 * (review 6291233350 P1).
 */
function choiceLabelPrefix(value: string): { index: number; remainder: string } | null {
  const normalized = value.normalize('NFKC').trim();
  // Leading-wrapper shapes「（C）选项原文」/「【C】开封」(sourcing.ts declares
  // both legal). A wrapper-only string carries no remainder to strip — the
  // caller's label expansion (choiceLabelIndex) resolves it instead.
  const leading = /^[(（[【]\s*([A-F])\s*[)）\]】]\s*(.*)$/u.exec(normalized);
  if (leading) {
    const label = leading[1] ?? '';
    const remainder = (leading[2] ?? '').trim();
    return remainder.length > 0
      ? { index: label.charCodeAt(0) - 'A'.charCodeAt(0), remainder }
      : null;
  }
  // Try the balanced-bracket shape first. Otherwise `A (content)` is consumed
  // by the generic separator branch at the space and retains `(content)`.
  // A labelled answer is persisted with an uppercase option marker. Keep this
  // case-sensitive: treating lowercase function names such as `f(x)` as an
  // option wrapper would add the false candidate `x` and could normalize-pass
  // an actually wrong fill-blank answer.
  const match = /^([A-F])(?:\s*[(（[【]\s*(.+?)\s*[)）\]】]\s*$|[\s.、:：)\]）-]+(.+))$/u.exec(
    normalized,
  );
  const label = match?.[1];
  const remainder = (match?.[2] ?? match?.[3])?.trim();
  if (!label || !remainder || remainder.length === 0) return null;
  return { index: label.charCodeAt(0) - 'A'.charCodeAt(0), remainder };
}

function stripLeadingChoiceLabel(value: string): string | null {
  return choiceLabelPrefix(value)?.remainder ?? null;
}

// A1 (独立 review) — trailing sentence-punctuation variant for exact compare, applied
// symmetrically to BOTH reference and solver candidates via answerCandidates. normalizeAnswer
// deliberately strips whitespace only (mathematical symbols are load-bearing), so 『长安。』 vs
// 『长安』 was a stable false fail. Conservative trailing set: full-width 。．！？ + ASCII .!?
// trailing-only, so interior punctuation ("3.14", "x=-1") is untouched.
function stripTrailingPunct(value: string): string | null {
  const stripped = value.replace(/[。．.!！?？]+$/u, '').trim();
  return stripped.length > 0 && stripped !== value ? stripped : null;
}

function addChoiceExpansion(out: string[], choice: string | undefined): void {
  if (!choice) return;
  // `choices_md` entries are option bodies, not answer wrappers. Re-running
  // wrapper stripping here would turn a real option such as F(x) into the false
  // candidate x. Explicit labels are stripped only from answer strings above.
  out.push(choice);
}

export function answerCandidates(
  text: string,
  choices: readonly string[],
  allowChoiceWrapper: boolean,
): string[] {
  const out = [text];
  // Parenthesized A-F wrappers are only meaningful for an actual choice item.
  // Outside that context, F(x) / A(t) are load-bearing mathematical notation.
  const stripped = allowChoiceWrapper ? stripLeadingChoiceLabel(text) : null;
  if (stripped) out.push(stripped);

  const labelIndex = choiceLabelIndex(text);
  if (labelIndex !== null) {
    addChoiceExpansion(out, choices[labelIndex]);
  }

  // A1 — trailing-punct variant of every candidate gathered so far (both sides of the
  // compare flow through here, so 『长安』↔『长安。』 matches in either direction).
  for (const candidate of [...out]) {
    const trimmed = stripTrailingPunct(candidate);
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }

  return out;
}

// ---------- deterministic choice-surface pre-checks (#24) ----------

export type ChoiceSurfaceRule =
  | 'insufficient_choices'
  | 'duplicate_options'
  | 'reference_not_in_choices';

export interface ChoiceSurfaceRuleCheck {
  rule: ChoiceSurfaceRule;
  verdict: 'pass' | 'reject';
  reason: string;
}

/**
 * The precheck record persisted on the admission record for EVERY outcome —
 * reject or pass (PM condition,): each rule's name, verdict, and a
 * concrete reason, so a reviewer can audit what the deterministic gate decided
 * without re-deriving it. `not_applicable` marks a row the rules genuinely do
 * not cover (an option-less non-choice kind) — recorded explicitly instead of
 * masquerading as a pass with no rules.
 */
export interface ChoiceSurfacePrecheckRecord {
  outcome: 'pass' | 'reject' | 'not_applicable';
  rules: ChoiceSurfaceRuleCheck[];
  /** Present only when outcome='not_applicable': why the rules do not apply. */
  reason?: string;
}

export interface ChoiceSurfaceQuestion {
  kind: string;
  reference_md: string | null;
  choices_md: string[] | null;
  rubric_json: unknown;
  /** A composite (篇) parent carries its options in structured.sub_questions, not flat choices_md. */
  hasStructuredStem?: boolean;
}

function referenceFirstLine(referenceMd: string | null): string | null {
  const fallback = (referenceMd ?? '').trim();
  if (fallback.length === 0) return null;
  return (fallback.split(/\r?\n/, 1)[0] ?? '').trim() || null;
}

/** Case-preserving option identity: NFKC + whitespace only (duplicate detection). */
function normalizeOptionIdentity(text: string): string {
  return text.normalize('NFKC').replace(/[\s　]+/gu, '');
}

/**
 * Choice-surface rules that can decide before ANY paid verify call runs —
 * the model is reserved for what rules cannot judge. Applies to every flat row
 * whose kind folds to the choice family (a choice row with ZERO options is
 * rejected too) and to any row that carries persisted options (a lone option
 * is choice-shaped regardless of its kind label). Composite (篇) parents are
 * exempt via hasStructuredStem: their options live in structured
 * sub-questions, not flat choices_md. Option-less non-choice kinds record
 * not_applicable. Answer resolution reuses the solve-check candidates, so
 * `B`, `B. …`, `（B）选项原文`, `【B】…` and a structured rubric final_answer
 * all count as the declared answer; a multi-select reference like `A、C`
 * passes when every label resolves to a real option. A label must be
 * delimiter-separated from its text (`B.` / `（B）` / whitespace) — an option
 * body like `C语言` is never stripped. Duplicate detection preserves case:
 * `T` / `t` are different physical symbols, so only NFKC-and-whitespace-equal
 * options collide.
 */
export function evaluateChoiceSurface(question: ChoiceSurfaceQuestion): ChoiceSurfaceRuleCheck[] {
  const choices = question.choices_md ?? [];
  const choiceShaped =
    !question.hasStructuredStem && normalizeToCanonicalKind(question.kind) === 'choice';
  if (choices.length === 0 && !choiceShaped) return [];
  if (choices.length < 2) {
    return [
      {
        rule: 'insufficient_choices',
        verdict: 'reject',
        reason: `选项数 ${choices.length}，不足 2`,
      },
    ];
  }

  const checks: ChoiceSurfaceRuleCheck[] = [
    {
      rule: 'insufficient_choices',
      verdict: 'pass',
      reason: `选项数 ${choices.length}`,
    },
  ];

  const identities = choices.map((choice) => normalizeOptionIdentity(choice));
  const collisions: string[] = [];
  const seen = new Map<string, number>();
  for (const [index, identity] of identities.entries()) {
    const firstIndex = seen.get(identity);
    if (firstIndex === undefined) {
      seen.set(identity, index);
      continue;
    }
    if (collisions.length < 3) {
      collisions.push(`第 ${firstIndex + 1}、${index + 1} 项规范化后相同`);
    }
  }
  checks.push(
    collisions.length > 0
      ? { rule: 'duplicate_options', verdict: 'reject', reason: collisions.join('；') }
      : { rule: 'duplicate_options', verdict: 'pass', reason: '规范化后（保留大小写）无重复' },
  );

  const normalizedOptions = choices.map((choice) => normalizeAnswer(choice));
  const matchOptionIndex = (text: string, allowChoiceWrapper: boolean): number => {
    for (const expanded of answerCandidates(text, choices, allowChoiceWrapper)) {
      const index = normalizedOptions.indexOf(normalizeAnswer(expanded));
      if (index >= 0) return index;
    }
    return -1;
  };
  const firstLine = referenceFirstLine(question.reference_md);
  const labels = firstLine ? firstLine.split(/[、，,\s]+/u).filter(Boolean) : [];
  const resolvedLabelIndices = labels.map((token) => {
    const index = choiceLabelIndex(token);
    return index !== null && index < choices.length ? index : null;
  });
  const everyTokenIsResolvableLabel =
    labels.length > 0 && resolvedLabelIndices.every((index) => index !== null);
  // Same candidate composition the solve-check exact path uses, so `B`,
  // `B. …`, `（B）选项原文` and structured rubric answers all resolve. A
  // label-prefixed reference whose remainder names a DIFFERENT option is
  // internally inconsistent — reject instead of guessing which side is right.
  let matchedOptionIndices: number[] = [];
  let inconsistencyReason: string | null = null;
  if (everyTokenIsResolvableLabel) {
    matchedOptionIndices = resolvedLabelIndices.filter((index): index is number => index !== null);
  } else {
    const parsedPrefix = firstLine != null ? choiceLabelPrefix(firstLine) : null;
    // An out-of-range label (e.g. `E. 选项` on 4 options) is not a usable label
    // at all — fall through to whole-text matching instead of asserting an
    // option that does not exist.
    const prefix =
      parsedPrefix != null && parsedPrefix.index < choices.length ? parsedPrefix : null;
    if (prefix) {
      const textIndex = matchOptionIndex(prefix.remainder, false);
      if (textIndex >= 0 && textIndex !== prefix.index) {
        inconsistencyReason = `标签 ${String.fromCharCode(65 + prefix.index)} 指向选项 ${prefix.index + 1}，但选项文本命中第 ${textIndex + 1} 项，前后不一致`;
      } else if (textIndex === prefix.index) {
        matchedOptionIndices = [prefix.index];
      }
    }
    if (matchedOptionIndices.length === 0 && inconsistencyReason === null) {
      for (const candidate of referenceAnswerCandidates(question)) {
        const index = matchOptionIndex(candidate, true);
        if (index >= 0) {
          matchedOptionIndices = [index];
          break;
        }
      }
    }
  }
  checks.push(
    inconsistencyReason !== null
      ? {
          rule: 'reference_not_in_choices',
          verdict: 'reject',
          reason: inconsistencyReason,
        }
      : matchedOptionIndices.length > 0
        ? {
            rule: 'reference_not_in_choices',
            verdict: 'pass',
            reason: `参考答案命中选项 ${matchedOptionIndices.map((index) => index + 1).join('、')}`,
          }
        : {
            rule: 'reference_not_in_choices',
            verdict: 'reject',
            reason: '参考答案首行未命中任何选项（含标签与 rubric 结构化答案展开）',
          },
  );

  return checks;
}

/** Fold per-rule checks into the admission-record precheck block. */
export function choiceSurfacePrecheckRecord(
  checks: ChoiceSurfaceRuleCheck[],
): ChoiceSurfacePrecheckRecord {
  if (checks.length === 0) {
    return {
      outcome: 'not_applicable',
      rules: [],
      reason: '非 choice 题型且无选项，预检不适用',
    };
  }
  return {
    outcome: checks.some((check) => check.verdict === 'reject') ? 'reject' : 'pass',
    rules: checks,
  };
}
