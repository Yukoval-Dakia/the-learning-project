// YUK-1729 — recovery after a refresh on the single-question page (use-practice-submit).

import type { PracticeClient } from './practice-client';

type IssuanceState = Awaited<ReturnType<PracticeClient['getIssuanceState']>>;
// YUK-1729 — a recovered terminal verdict that still needs the learner's rating step. Same split
// as onPendingSettled: review_required, partial_unknown, or an explicit null final rating.
type RecoveredTerminalRun = Extract<
  NonNullable<IssuanceState['settled']>,
  { kind: 'terminal' }
>['run'];
export function verdictNeedsLearnerRating(run: RecoveredTerminalRun): boolean {
  const r = run.result;
  return (
    run.status === 'done' &&
    (r?.status === 'review_required' ||
      r?.coarse_outcome === 'partial_unknown' ||
      r?.final_rating === null)
  );
}
