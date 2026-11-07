// What the Today AI failure notice shows: only work the learner started or is waiting on, one key
// per failure episode. Background work (question preparation, verification, knowledge upkeep) stays
// on /admin/runs, since a learner can neither feel it nor do anything about it.

import { learnerLocalDay } from '@/core/learner-day';

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
}
interface Alert {
  id: string;
  task_kind: string;
  rule: string;
}

/**
 * What closing also covers: an alert's failures land in the next night's digest under another key,
 * and without this the same failures would show again the next morning.
 */
export function failureNoticeCloseKeys(input: {
  digest?: { window: { to: string } };
  alerts?: readonly Alert[];
}): string[] {
  const nextWindow = input.digest?.window.to;
  if (!nextWindow) return [];
  return (input.alerts ?? [])
    .filter((alert) => alert.rule !== 'unsealed' && LEARNER_FELT_TASKS.has(alert.task_kind))
    .map((alert) => `digest:${nextWindow}:${alert.task_kind}`);
}

/** A digest failure is one key per kind per night; an alert id already names its episode. */
export function failureNoticeKeys(input: {
  digest?: { window: { from: string; to: string }; degraded_kinds: readonly DegradedKind[] };
  alerts?: readonly Alert[];
}): string[] {
  const digest = input.digest;
  return [
    ...(digest?.degraded_kinds ?? [])
      .filter((kind) => LEARNER_FELT_TASKS.has(kind.task_kind))
      .map((kind) => `digest:${digest?.window.from}:${kind.task_kind}`),
    // An unsealed reply reached the learner; only its closing record is incomplete.
    ...(input.alerts ?? [])
      .filter((alert) => alert.rule !== 'unsealed' && LEARNER_FELT_TASKS.has(alert.task_kind))
      .map((alert) => alert.id),
  ];
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
