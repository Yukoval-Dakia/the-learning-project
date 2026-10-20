// YUK-1572 — tier-2 deterministic pre-check cluster, extracted from
// source_verify.ts (the "deterministic checks" block; the moved rule bodies are
// verbatim).
//
// This module owns the PURE, DB-free half of the tier-2 check set
// (CHECK_SETS_BY_TIER[2] = structure_completeness + source_consistency +
// solve_check + dedup): the two checks that decide — from question content
// alone — whether a web_sourced draft is structurally complete and honestly
// sourced. dedup stays in source_verify.ts (it queries the pool) and
// solve_check stays there (it spends the LLM call via
// verify-framework.runSolveCheck). Nothing here touches db / network / LLM:
// same input ⇒ same verdict, same reason text.
//
// CheckOutcome is the per-check verdict record for the whole source_verify
// handler — dedup / solve_check / source_grounding outcomes are recorded in
// the same shape. It is declared here (the dependency leaf) so the import
// direction stays one-way: source_verify.ts imports it for the checks it
// still owns and re-exports it to keep the existing import path.
//
// SourceVerifyPrecheckInput is exactly the field set these checks read. The
// handler passes its verify-input — a question row, or its frozen-revision
// flat projection carrying the same fields — which satisfies this shape
// structurally, so this module never couples to the full row/schema. Rule
// changes (required fields, thresholds, provenance interpretation) are local
// to this file: the caller does not need to know which fields feed which
// check.

import { WebSourcedProvenance, deriveSourceTier } from '@/core/schema/provenance';
import { normalizeToCanonicalKind } from '@/subjects/question-kind';
import { maxNgramOverlap } from '../server/question-supply/sourced-dedup';
import type { VerifyCheck } from '../server/quiz/verify-framework';

export interface CheckOutcome {
  check: VerifyCheck;
  // pass = the check is satisfied; fail = a hard problem; unsupported = no signal
  // (normally non-blocking; an unresolved exact mismatch is held in tier 2).
  verdict: 'pass' | 'fail' | 'unsupported';
  reason: string;
}

/**
 * The exact field set the deterministic pre-checks read — a strict subset of
 * the question row (`typeof question.$inferSelect`), declared here instead of
 * importing the schema so the module stays DB-free even at the type level.
 * Field types mirror the column types the handler passes in.
 */
export interface SourceVerifyPrecheckInput {
  kind: string;
  prompt_md: string;
  reference_md: string | null;
  choices_md: string[] | null;
  source: string;
  source_ref: string | null;
  metadata: Record<string, unknown> | null;
}

// structure_completeness — the row carries the fields its kind requires. Only
// `choice` requires ≥2 options; every kind needs a non-empty prompt + reference
// answer. true_false is INTENTIONALLY exempt: the repo's existing 判断题 form is
// kind='true_false' + reference_md carrying 真/假 with NO choices_md (practice/paper
// fixtures share this shape, and judge routing dispatches true_false straight to
// exact). Forcing ≥2 choices onto sourced true_false rows would strand every
// option-less 判断题 in draft forever (F1).
export function checkStructureCompleteness(row: SourceVerifyPrecheckInput): CheckOutcome {
  const problems: string[] = [];
  if (!row.prompt_md || row.prompt_md.trim().length === 0) problems.push('empty prompt_md');
  if (!row.reference_md || row.reference_md.trim().length === 0) {
    problems.push('empty reference_md');
  }
  // YUK-386 — kind is a free-form label; fold through the vocab (single_choice /
  // multiple_choice → choice) so legacy profile-vocab rows keep the same check,
  // then read the STRUCTURE: a choice-shaped row must carry ≥2 options.
  const choices = row.choices_md ?? [];
  if (
    (normalizeToCanonicalKind(row.kind) === 'choice' || choices.length === 1) &&
    choices.length < 2
  ) {
    problems.push('choice question has <2 choices');
  }
  return problems.length === 0
    ? { check: 'structure_completeness', verdict: 'pass', reason: 'all required fields present' }
    : { check: 'structure_completeness', verdict: 'fail', reason: problems.join('; ') };
}

// Minimum deterministic overlap between a sourced question's prompt+reference and the
// extract the agent reported lifting from the declared source page. BELOW this, the
// stored content does not support the declared provenance (mis-extraction or a
// fabricated/guessed URL) and source_consistency fails. This is the INVERSE direction
// of quiz_verify's copy_safety (which fails on HIGH overlap to catch plagiarism):
// here a sourced question SHOULD closely echo its real source. Reuses the same
// deterministic word-shingle overlap (maxNgramOverlap, CJK-aware). CONSERVATIVE start
// — the gate only fires when an extract is present AND clearly fails to ground the
// question, so genuine restructuring (paraphrase) is not punished. Tunable.
export const SOURCE_GROUNDING_MIN_OVERLAP = 0.15;

// source_consistency — the row's declared source matches its persisted provenance:
// deriveSourceTier lands tier 2, the web_sourced block parses, source_ref is present
// and equals the provenance URL, AND (when the agent persisted an extract) the
// prompt+reference deterministically overlap that extract. A web_sourced row that
// does NOT derive tier 2, omits source_ref, or whose stored content does not ground
// the declared source page is rejected. The overlap is DETERMINISTIC over the
// PERSISTED extract — verify never refetches the network (mirrors the quiz_gen
// source_pack snippet → quiz_verify maxNgramOverlap precedent; spec §4).
export function checkSourceConsistency(row: SourceVerifyPrecheckInput): CheckOutcome {
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  // F2: extract is the deterministic grounding anchor. A web_sourced row without a
  // non-empty extract cannot derive tier 2 (WebSourcedProvenance now requires it), so
  // the generic tier check below already rejects it — but check it FIRST so the audit
  // reason names extract precisely rather than the opaque "missing or malformed".
  const rawWebSourced = (metadata.web_sourced ?? {}) as Record<string, unknown>;
  const rawExtract = rawWebSourced.extract;
  if (typeof rawExtract !== 'string' || rawExtract.trim().length === 0) {
    return {
      check: 'source_consistency',
      verdict: 'fail',
      reason:
        'web_sourced row has no extract; the declared source cannot be deterministically grounded (fabricated/unanchored URL risk)',
    };
  }
  const { tier } = deriveSourceTier({ source: row.source, metadata });
  if (tier !== 2) {
    return {
      check: 'source_consistency',
      verdict: 'fail',
      reason: `web_sourced row does not derive tier 2 (got tier ${tier}); provenance is missing or malformed`,
    };
  }
  const parsed = WebSourcedProvenance.safeParse(metadata.web_sourced);
  if (!parsed.success) {
    return {
      check: 'source_consistency',
      verdict: 'fail',
      reason: `metadata.web_sourced failed provenance parse: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    };
  }
  // A web_sourced question with no source_ref has incomplete provenance — the column
  // is supposed to carry the fetched URL (合约三). Missing → fail (CR), not pass.
  if (!row.source_ref) {
    return {
      check: 'source_consistency',
      verdict: 'fail',
      reason: 'source_ref is missing for web_sourced question',
    };
  }
  if (row.source_ref !== parsed.data.url) {
    return {
      check: 'source_consistency',
      verdict: 'fail',
      reason: `source_ref (${row.source_ref}) disagrees with provenance url (${parsed.data.url})`,
    };
  }
  // Deterministic content grounding (F2). extract is guaranteed non-empty here (the
  // top-of-function guard + the required WebSourcedProvenance.extract contract). The
  // question's prompt+reference must overlap it — a mis-extracted or fabricated source
  // carries an extract that does not echo the question → fail.
  const extract = parsed.data.extract;
  const questionText = `${row.prompt_md}\n${row.reference_md}`;
  const overlap = maxNgramOverlap(questionText, [extract]);
  if (overlap < SOURCE_GROUNDING_MIN_OVERLAP) {
    return {
      check: 'source_consistency',
      verdict: 'fail',
      reason: `question content does not ground its declared source (overlap ${overlap.toFixed(2)} < ${SOURCE_GROUNDING_MIN_OVERLAP}); extract may be mis-attributed or fabricated`,
    };
  }
  return {
    check: 'source_consistency',
    verdict: 'pass',
    reason: `tier 2 sourced provenance consistent + content grounded (url ${parsed.data.url}, overlap ${overlap.toFixed(2)})`,
  };
}
