// Result projection for tier-2 source verification: map solve outcomes and summarize
// checks after the job has decided promotion.

import { toUnifiedVerifyResult } from '@/core/schema/verify-contract';
import type { VectorNearHold } from '../server/question-supply/ingest-dedup';
import type { SolveCheckResult } from '../server/quiz/verify-framework';
import type { CheckOutcome } from './source_verify_prechecks';

export function solveCheckToOutcome(result: SolveCheckResult): CheckOutcome {
  // The solve-check is conservative: 'unsupported' carries no signal, so only a
  // confident 'fail' blocks promotion.
  return {
    check: 'solve_check',
    verdict:
      result.verdict === 'fail' ? 'fail' : result.verdict === 'pass' ? 'pass' : 'unsupported',
    reason: result.reason,
  };
}

type SourceVerifyResultInput = {
  checks: CheckOutcome[];
  promote: boolean;
  unresolvedAnchoredExactMismatch: boolean;
  imageInputUnavailable: boolean;
  knowledgeAlive: boolean;
  vectorNearHold: VectorNearHold | null;
};

export function projectSourceVerifyResult({
  checks,
  promote,
  unresolvedAnchoredExactMismatch,
  imageInputUnavailable,
  knowledgeAlive,
  vectorNearHold,
}: SourceVerifyResultInput) {
  const failingCheck = checks.find((c) => c.verdict === 'fail');
  const sourceSummaryMd = promote
    ? 'tier-2 source verify passed'
    : failingCheck
      ? `tier-2 source verify failed: ${failingCheck.check} — ${failingCheck.reason}`
      : unresolvedAnchoredExactMismatch
        ? 'tier-2 source verify needs review: exact answer mismatch remained unresolved'
        : imageInputUnavailable
          ? 'tier-2 source verify needs review: prompt image content was unavailable'
          : !knowledgeAlive
            ? 'referenced knowledge point archived after sourcing; not promoted'
            : vectorNearHold
              ? `tier-2 source verify needs review: vector similarity ${vectorNearHold.similarity.toFixed(3)} with ${vectorNearHold.neighbor_question_id}`
              : 'tier-2 source verify did not promote';
  const unified = toUnifiedVerifyResult({
    source: 'source',
    promote,
    summary_md: sourceSummaryMd,
    // The handler has no calibrated scalar confidence, so report a flat 1 per verdict;
    // the axes and overall carry the signal.
    confidence: 1,
    checks: checks.map((c) => ({ check: c.check, verdict: c.verdict, reason: c.reason })),
  });
  return { failingCheck, unified };
}
