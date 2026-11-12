// What the Today AI failure notice shows: only work the learner started or is waiting on, one key
// per failure episode. Background work (question preparation, verification, knowledge upkeep) stays
// on /admin/runs, since a learner can neither feel it nor do anything about it.

import { learnerLocalDay } from '@/core/learner-day';

const DAY_MS = 86_400_000;

const LEARNER_FELT_TASKS: ReadonlySet<string> = new Set([
  // The companion.
  'CopilotTask',
  'TeachingTurnTask',
  'TeachingTurnVisionTask',
  // Grading what the learner answered.
  'AssessmentRubricJudgeTask',
  'AssessmentRuleJudgeTask',
  'JevScoringDecisionTask',
  'MultimodalDirectJudgeTask',
  'SemanticJudgeTask',
  'StepsJudgeTask',
  'UnitDimensionFallback',
  // Material the learner brought in.
  'IngestionAgentTask',
  'StructureTask',
  'BlockAssemblyTask',
  'VisionExtractTask',
  'VisionExtractTaskHeavy',
  // Notes the learner asked for.
  'NoteGenerateTask',
  'NoteRefineTask',
]);

interface DegradedKind {
  task_kind: string;
  /** Newest failure of this kind in the digest window; part of the episode key. */
  last_at: string;
}
interface Alert {
  id: string;
  task_kind: string;
  rule: string;
}

/**
 * What closing also covers: an alert's failures land in the next digest, whose episode key
 * depends on their future `last_at`. Mute the kind for that one reading instead. The digest
 * ends at today's BJT midnight, so the next reading ends one day later.
 */
export function failureNoticeCloseKeys(input: {
  digest?: { window: { to: string } };
  alerts?: readonly Alert[];
}): string[] {
  const windowTo = input.digest ? Date.parse(input.digest.window.to) : Number.NaN;
  if (!Number.isFinite(windowTo)) return [];
  const nextReadingEnd = new Date(windowTo + DAY_MS).toISOString();
  return (input.alerts ?? [])
    .filter((alert) => alert.rule !== 'unsealed' && LEARNER_FELT_TASKS.has(alert.task_kind))
    .map((alert) => `digest-kind:${nextReadingEnd}:${alert.task_kind}`);
}

/**
 * A digest failure is one key per episode: kind plus newest failure time, so a new failure
 * shows again while an older one of the same kind is still inside the widened window.
 * An alert id already names its episode.
 */
export function failureNoticeKeys(input: {
  digest?: { window: { from: string; to: string }; degraded_kinds: readonly DegradedKind[] };
  alerts?: readonly Alert[];
  closed?: ReadonlySet<string>;
}): string[] {
  const digest = input.digest;
  const closed = input.closed ?? new Set<string>();
  const muted = (taskKind: string) => `digest-kind:${digest?.window.to}:${taskKind}`;
  return [
    ...(digest?.degraded_kinds ?? [])
      .filter((kind) => LEARNER_FELT_TASKS.has(kind.task_kind))
      .filter((kind) => !closed.has(muted(kind.task_kind)))
      .map((kind) => `digest:${kind.task_kind}:${kind.last_at}`),
    // An unsealed reply reached the learner; only its closing record is incomplete.
    ...(input.alerts ?? [])
      .filter((alert) => alert.rule !== 'unsealed' && LEARNER_FELT_TASKS.has(alert.task_kind))
      .map((alert) => alert.id),
  ].filter((key) => !closed.has(key));
}

/**
 * A dependency notice has no episode id, and its `since` only moves once an outage outlasts the
 * read's 7-day window. Keyed by the learner's day, so a long outage reminds at most daily.
 */
export function dependencyNoticeKey(notice: {
  dependency: string;
  category: string;
  since: string;
}): string {
  return `dep:${notice.dependency}:${notice.category}:${learnerLocalDay(new Date(notice.since))}`;
}
