// What the Today AI failure notice shows: only work the learner started or is waiting on, one key
// per failure episode. Background work (question preparation, verification, knowledge upkeep) stays
// on /admin/runs, since a learner can neither feel it nor do anything about it.

const LEARNER_FELT_TASKS: ReadonlySet<string> = new Set([
  // The companion.
  'CopilotTask',
  'TeachingTurnTask',
  'TeachingTurnVisionTask',
  // Grading what the learner answered.
  'AssessmentRubricJudgeTask',
  'AssessmentRuleJudgeTask',
  'MultimodalDirectJudgeTask',
  'SemanticJudgeTask',
  'StepsJudgeTask',
  // Material the learner brought in.
  'IngestionAgentTask',
  'StructureTask',
  'BlockAssemblyTask',
  'VisionExtractTask',
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

/** A digest failure is one key per kind per night; an alert id already names its episode. */
export function failureNoticeKeys(input: {
  digest?: { window: { from: string }; degraded_kinds: readonly DegradedKind[] };
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

const WEEK_MS = 7 * 86_400_000;

/**
 * A dependency notice has no episode id, and its `since` only moves once an outage outlasts the
 * read's 7-day window. Keying by the week of `since` keeps one outage to at most a weekly reminder.
 */
export function dependencyNoticeKey(notice: {
  dependency: string;
  category: string;
  since: string;
}): string {
  const week = Math.floor(Date.parse(notice.since) / WEEK_MS);
  return `dep:${notice.dependency}:${notice.category}:${week}`;
}
