// YUK-1729 — recovery after a refresh on the single-question page (use-practice-submit).

// The verdict fields that decide whether a terminal judge result still needs the learner's rating.
interface RatingFacts {
  status?: string;
  coarse_outcome?: string;
  final_rating?: string | null;
}

// A terminal verdict the learner still has to rate: same split as onPendingSettled
// (review_required, partial_unknown, or an explicit null final rating). Such a verdict is not
// shown as a settled card: that card's commit needs this visit's own preview and activation
// intent, so it goes back through the advice replay into the confidence/rating step.
export function verdictNeedsLearnerRating(
  status: string | null,
  result: RatingFacts | null,
): boolean {
  return (
    status === 'done' &&
    (result?.status === 'review_required' ||
      result?.coarse_outcome === 'partial_unknown' ||
      result?.final_rating === null)
  );
}
