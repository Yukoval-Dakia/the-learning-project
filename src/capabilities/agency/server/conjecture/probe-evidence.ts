import { PROBE_RESOLUTION_RULE_VERSION, PROBE_RESULT_ACTION } from '@/core/schema/conjecture';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { getCorrectionStatuses } from '@/kernel/events';
import { and, eq, inArray } from 'drizzle-orm';

type DbLike = Db | Tx;

export type EffectiveProbeResultStatus = 'active' | 'corrected' | 'dependency_inactive' | 'missing';

interface ProbeResultRow {
  id: string;
  subject_id: string;
  caused_by_event_id: string | null;
  payload: unknown;
}

const probeResultColumns = {
  id: event.id,
  subject_id: event.subject_id,
  caused_by_event_id: event.caused_by_event_id,
  payload: event.payload,
} as const;

function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function supportingQuestionIds(row: ProbeResultRow): string[] | null {
  const payload = toRecord(row.payload);
  if (
    payload.resolution !== 'confirmed' ||
    payload.outcome !== 0 ||
    payload.resolution_rule_version !== PROBE_RESOLUTION_RULE_VERSION
  ) {
    return null;
  }
  const rawIds = payload.independent_probe_question_ids;
  if (!Array.isArray(rawIds)) {
    console.warn(
      '[probe-evidence] confirmed v2 recurrence has invalid independent_probe_question_ids',
      row.id,
    );
    return [];
  }
  return [...new Set(rawIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
}

function isCanonicalSupportingResult(row: ProbeResultRow, conjectureEventId: string): boolean {
  const payload = toRecord(row.payload);
  return (
    row.caused_by_event_id === conjectureEventId &&
    payload.conjecture_event_id === conjectureEventId &&
    payload.outcome === 0 &&
    (payload.resolution === 'evidence_for' || payload.resolution === 'confirmed')
  );
}

/**
 * Fold the effective status of probe results, including the dependency edge of a
 * v2 recurrence confirmation. Correcting either the terminal result or any
 * supporting result referenced by `independent_probe_question_ids` invalidates
 * the terminal evidence until the corrected result is restored.
 */
export async function getEffectiveProbeResultStatuses(
  db: DbLike,
  probeResultEventIds: readonly string[],
): Promise<Map<string, EffectiveProbeResultStatus>> {
  const ids = [...new Set(probeResultEventIds)];
  const statuses = new Map<string, EffectiveProbeResultStatus>(ids.map((id) => [id, 'missing']));
  if (ids.length === 0) return statuses;

  const rows = await db
    .select(probeResultColumns)
    .from(event)
    .where(
      and(
        eq(event.action, PROBE_RESULT_ACTION),
        eq(event.subject_kind, 'question'),
        inArray(event.id, ids),
      ),
    );
  const correctionStatuses = await getCorrectionStatuses(
    db,
    rows.map((row) => row.id),
  );

  const activeRows = rows.filter((row) => {
    if (correctionStatuses.get(row.id)?.state === 'active') return true;
    statuses.set(row.id, 'corrected');
    return false;
  });
  const recurrenceRows = activeRows.flatMap((row) => {
    const questionIds = supportingQuestionIds(row);
    return questionIds === null ? [] : [{ row, questionIds }];
  });
  const dependencyQuestionIds = [
    ...new Set(recurrenceRows.flatMap(({ questionIds }) => questionIds)),
  ];
  const dependencyRows =
    dependencyQuestionIds.length === 0
      ? []
      : await db
          .select(probeResultColumns)
          .from(event)
          .where(
            and(
              eq(event.action, PROBE_RESULT_ACTION),
              eq(event.subject_kind, 'question'),
              inArray(event.subject_id, dependencyQuestionIds),
            ),
          );
  const dependencyCorrections = await getCorrectionStatuses(
    db,
    dependencyRows.map((row) => row.id),
  );

  for (const row of activeRows) statuses.set(row.id, 'active');
  for (const { row, questionIds } of recurrenceRows) {
    const conjectureEventId = toRecord(row.payload).conjecture_event_id;
    if (
      typeof conjectureEventId !== 'string' ||
      questionIds.length < 2 ||
      !questionIds.includes(row.subject_id)
    ) {
      statuses.set(row.id, 'dependency_inactive');
      continue;
    }
    const allQuestionsActive = questionIds.every((questionId) =>
      dependencyRows.some(
        (dependency) =>
          dependency.subject_id === questionId &&
          dependencyCorrections.get(dependency.id)?.state === 'active' &&
          isCanonicalSupportingResult(dependency, conjectureEventId),
      ),
    );
    if (!allQuestionsActive) statuses.set(row.id, 'dependency_inactive');
  }

  return statuses;
}
