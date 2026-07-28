import {
  PROBE_QUESTION_SOURCE,
  PROBE_RESOLUTION_RULE_VERSION,
  PROBE_RESULT_ACTION,
} from '@/core/schema/conjecture';
import { AiProposalPayload } from '@/core/schema/proposal';
import type { Db, Tx } from '@/db/client';
import { event, question } from '@/db/schema';
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

interface ConjectureProbeSpec {
  id: string;
  knowledgeId: string;
  promptMd: string;
  followupPromptMd: string | null;
}

type SupportingQuestionRow = Pick<
  typeof question.$inferSelect,
  'id' | 'source' | 'source_ref' | 'draft_status' | 'prompt_md' | 'knowledge_ids' | 'metadata'
>;

const probeResultColumns = {
  id: event.id,
  subject_id: event.subject_id,
  caused_by_event_id: event.caused_by_event_id,
  payload: event.payload,
} as const;

const supportingQuestionColumns = {
  id: question.id,
  source: question.source,
  source_ref: question.source_ref,
  draft_status: question.draft_status,
  prompt_md: question.prompt_md,
  knowledge_ids: question.knowledge_ids,
  metadata: question.metadata,
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

function parseConjectureProbeSpec(row: typeof event.$inferSelect): ConjectureProbeSpec | null {
  const parsed = AiProposalPayload.safeParse(toRecord(row.payload).ai_proposal);
  if (
    !parsed.success ||
    parsed.data.kind !== 'conjecture' ||
    row.action !== 'experimental:proposal' ||
    row.subject_kind !== 'mind_model'
  ) {
    return null;
  }
  const change = parsed.data.proposed_change;
  if (
    parsed.data.target.subject_kind !== 'mind_model' ||
    parsed.data.target.subject_id !== change.knowledge_id ||
    row.subject_id !== change.knowledge_id
  ) {
    return null;
  }
  return {
    id: row.id,
    knowledgeId: change.knowledge_id,
    promptMd: change.probe_md,
    followupPromptMd: change.followup_probe_md ?? null,
  };
}

function supportingQuestionSequence(
  row: SupportingQuestionRow,
  spec: ConjectureProbeSpec,
): 1 | 2 | null {
  const metadata = toRecord(row.metadata);
  const sequence = metadata.probe_sequence ?? 1;
  if (sequence !== 1 && sequence !== 2) return null;
  const expectedPrompt = sequence === 2 ? spec.followupPromptMd : spec.promptMd;
  if (
    row.source !== PROBE_QUESTION_SOURCE ||
    row.source_ref !== spec.id ||
    row.draft_status !== 'draft' ||
    metadata.conjecture_proposal_id !== spec.id ||
    row.knowledge_ids.length === 0 ||
    row.knowledge_ids[0] !== spec.knowledgeId ||
    expectedPrompt === null ||
    row.prompt_md !== expectedPrompt
  ) {
    return null;
  }
  return sequence;
}

/**
 * Fold the effective status of probe results, including the dependency edge of a
 * v2 recurrence confirmation. Evidence is active only while its proposal-specific
 * question chain remains canonical. Correcting either the terminal result or any
 * supporting result referenced by `independent_probe_question_ids`, or drifting
 * any supporting question's prompt/KC/provenance, invalidates the terminal evidence.
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
  const recurrenceConjectureEventIds = [
    ...new Set(
      recurrenceRows.flatMap(({ row }) => {
        const conjectureEventId = toRecord(row.payload).conjecture_event_id;
        return typeof conjectureEventId === 'string' ? [conjectureEventId] : [];
      }),
    ),
  ];
  const dependencyRows =
    dependencyQuestionIds.length === 0 || recurrenceConjectureEventIds.length === 0
      ? []
      : await db
          .select(probeResultColumns)
          .from(event)
          .where(
            and(
              eq(event.action, PROBE_RESULT_ACTION),
              eq(event.subject_kind, 'question'),
              inArray(event.subject_id, dependencyQuestionIds),
              inArray(event.caused_by_event_id, recurrenceConjectureEventIds),
            ),
          );
  const dependencyCorrections = await getCorrectionStatuses(
    db,
    dependencyRows.map((row) => row.id),
  );

  // Direct evidence keeps its existing correction-only status fold; the
  // proposal/question chain is authoritative in each consumer's full validator.
  // Recurrence is stricter here because every supporting question must be
  // canonical before the terminal result may strengthen the conjecture.
  const evidenceRows = dependencyRows;
  const evidenceQuestionIds = [...new Set(evidenceRows.map((row) => row.subject_id))];
  const evidenceConjectureEventIds = [
    ...new Set(
      evidenceRows.flatMap((row) => {
        const conjectureEventId = toRecord(row.payload).conjecture_event_id;
        return typeof conjectureEventId === 'string' ? [conjectureEventId] : [];
      }),
    ),
  ];
  // DbLike may be a single-connection transaction (probe answer/reconcile paths),
  // so keep these independent reads serial rather than issuing Promise.all on one tx.
  const questionRows =
    evidenceQuestionIds.length === 0
      ? []
      : await db
          .select(supportingQuestionColumns)
          .from(question)
          .where(inArray(question.id, evidenceQuestionIds));
  const proposalRows =
    evidenceConjectureEventIds.length === 0
      ? []
      : await db
          .select()
          .from(event)
          .where(
            and(
              eq(event.action, 'experimental:proposal'),
              eq(event.subject_kind, 'mind_model'),
              inArray(event.id, evidenceConjectureEventIds),
            ),
          );
  const questionById = new Map(questionRows.map((row) => [row.id, row] as const));
  const specByConjectureId = new Map(
    proposalRows.flatMap((row) => {
      const spec = parseConjectureProbeSpec(row);
      return spec ? [[spec.id, spec] as const] : [];
    }),
  );
  const sequenceForResult = (row: ProbeResultRow): 1 | 2 | null => {
    const conjectureEventId = toRecord(row.payload).conjecture_event_id;
    if (typeof conjectureEventId !== 'string') return null;
    const spec = specByConjectureId.get(conjectureEventId);
    const supportingQuestion = questionById.get(row.subject_id);
    return spec && supportingQuestion ? supportingQuestionSequence(supportingQuestion, spec) : null;
  };

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
    const supportingSequences = new Set<1 | 2>();
    const allQuestionsActive = questionIds.every((questionId) =>
      dependencyRows.some((dependency) => {
        if (
          dependency.subject_id !== questionId ||
          dependencyCorrections.get(dependency.id)?.state !== 'active' ||
          !isCanonicalSupportingResult(dependency, conjectureEventId)
        ) {
          return false;
        }
        const sequence = sequenceForResult(dependency);
        if (sequence === null) return false;
        supportingSequences.add(sequence);
        return true;
      }),
    );
    if (
      !allQuestionsActive ||
      supportingSequences.size !== 2 ||
      !supportingSequences.has(1) ||
      !supportingSequences.has(2)
    ) {
      statuses.set(row.id, 'dependency_inactive');
    }
  }

  return statuses;
}
