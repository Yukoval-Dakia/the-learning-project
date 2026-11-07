// What the Today AI failure notice shows: only work the learner started or is waiting on, one key
// per failure episode. Background work (question preparation, verification, knowledge upkeep) stays
// on /admin/runs, since a learner can neither feel it nor do anything about it.

const LEARNER_FELT_TASK =
  /copilot|teaching.?turn|note.?generate|judge|structure|block.?assembly|vision/i;

interface DegradedKind {
  task_kind: string;
}
interface Alert {
  id: string;
  task_kind: string;
  rule: string;
}

/** A digest failure is one key per kind per night; an alert id already names its episode. */
export function failureNoticeKeys(input: {
  digest?: { window: { from: string }; degraded_kinds: readonly DegradedKind[] };
  alerts?: readonly Alert[];
}): string[] {
  const digest = input.digest;
  return [
    ...(digest?.degraded_kinds ?? [])
      .filter((kind) => LEARNER_FELT_TASK.test(kind.task_kind))
      .map((kind) => `digest:${digest?.window.from}:${kind.task_kind}`),
    // An unsealed reply reached the learner; only its closing record is incomplete.
    ...(input.alerts ?? [])
      .filter((alert) => alert.rule !== 'unsealed' && LEARNER_FELT_TASK.test(alert.task_kind))
      .map((alert) => alert.id),
  ];
}

/** Keyed by the day a dependency's streak began, so it can't return every hour of one outage. */
export function dependencyNoticeKey(notice: {
  dependency: string;
  category: string;
  since: string;
}): string {
  return `dep:${notice.dependency}:${notice.category}:${notice.since.slice(0, 10)}`;
}
