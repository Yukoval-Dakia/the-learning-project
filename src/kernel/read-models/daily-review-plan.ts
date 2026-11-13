// Shared projection of the inputs `@/core/daily-review-plan` turns into
// counts and minutes, plus the first due knowledge points on those same rows.
// Practice still owns the due queue, the minute budget and the measured pace,
// and installs that reader: this module cannot import a capability.

import { inArray } from 'drizzle-orm';
import type { SubjectDueCount } from '@/core/daily-review-plan';
import { A5_BANDS, masteryBandIdx } from '@/core/mastery-band';
import { SchedulingStateSchema } from '@/core/schema/scheduling-state';
import type { Db, Tx } from '@/db/client';
import { knowledge } from '@/db/schema';
import { installHostOperation, installedHostOperation } from '@/kernel/host-operation';
import { getMasteryProjection } from '@/kernel/read-models/mastery-projection';
import { batchResolveSubjectIds } from '@/kernel/read-models/subject-resolution';
import { retrievabilityForKc } from '@/kernel/scheduling';
import { resolveSubjectProfile } from '@/subjects/profile';

type DbLike = Db | Tx;

const DUE_KNOWLEDGE_LIMIT = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface DailyReviewPlanDueRow {
  question_id: string;
  knowledge_ids?: readonly string[] | null;
  /** Present on the due-queue row this projection already reads. */
  fsrs_subject_kind?: 'question' | 'knowledge';
  fsrs_subject_id?: string;
  fsrs_state?: unknown;
}

/** One due knowledge point, taken from the same due rows as the plan counts. */
export interface DueKnowledgePoint {
  knowledge_id: string;
  name: string | null;
  /** Whole days past `due`. Null when the row has no due instant. */
  overdue_days: number | null;
  /** Current retention in [0, 1]. Null when the reading is unknown. */
  retention: number | null;
  /** Observed mastery band. Null when there is no evidence — never a cold-start 萌芽. */
  mastery_band: (typeof A5_BANDS)[number] | null;
}

export interface DailyReviewPlanFacts {
  due_rows: readonly DailyReviewPlanDueRow[];
  budget_minutes: number;
  question_minutes: number;
  question_minutes_source: 'observed' | 'default';
  question_minutes_sample_count: number;
}

export interface DailyReviewPlanInputs {
  due_count: number;
  due_by_subject: SubjectDueCount[];
  due_knowledge: DueKnowledgePoint[];
  budget_minutes: number;
  question_minutes: number;
  question_minutes_source: 'observed' | 'default';
  question_minutes_sample_count: number;
}

export type ReadDailyReviewPlanFacts = (db: DbLike, now: Date) => Promise<DailyReviewPlanFacts>;

const FACT_READER_SLOT = 'kernel/read-models/daily-review-plan:factReader';

export function installDailyReviewPlanFactReader(reader: ReadDailyReviewPlanFacts): void {
  installHostOperation(FACT_READER_SLOT, reader);
}

function duePointIds(row: DailyReviewPlanDueRow): readonly string[] {
  if (row.fsrs_subject_kind === 'knowledge' && row.fsrs_subject_id) return [row.fsrs_subject_id];
  return (row.knowledge_ids ?? []).filter((id) => id.length > 0);
}

function retentionNumber(reading: ReturnType<typeof retrievabilityForKc>): number | null {
  if (typeof reading === 'number') return reading;
  return reading.kind === 'score' ? reading.value : null;
}

/** Unknown retention stays null. Zero is a measured recall probability, not a missing reading. */
function dueSchedulingFacts(
  state: unknown,
  now: Date,
): { overdue_days: number | null; retention: number | null } {
  if (state == null) return { overdue_days: null, retention: null };
  const parsed = SchedulingStateSchema.safeParse(state);
  if (!parsed.success) return { overdue_days: null, retention: null };
  const dueMs = parsed.data.due.getTime();
  const overdueDays = Number.isNaN(dueMs)
    ? null
    : Math.max(0, Math.floor((now.getTime() - dueMs) / DAY_MS));
  return {
    overdue_days: overdueDays,
    retention: retentionNumber(retrievabilityForKc(parsed.data, now)),
  };
}

function selectDueKnowledge(
  rows: readonly DailyReviewPlanDueRow[],
  now: Date,
): Array<{ knowledge_id: string; overdue_days: number | null; retention: number | null }> {
  const picked: Array<{
    knowledge_id: string;
    overdue_days: number | null;
    retention: number | null;
  }> = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (picked.length >= DUE_KNOWLEDGE_LIMIT) break;
    const facts = dueSchedulingFacts(row.fsrs_state, now);
    for (const knowledgeId of duePointIds(row)) {
      if (picked.length >= DUE_KNOWLEDGE_LIMIT) break;
      if (seen.has(knowledgeId)) continue;
      seen.add(knowledgeId);
      picked.push({ knowledge_id: knowledgeId, ...facts });
    }
  }
  return picked;
}

async function labelDueKnowledge(
  db: DbLike,
  picked: ReadonlyArray<{
    knowledge_id: string;
    overdue_days: number | null;
    retention: number | null;
  }>,
): Promise<DueKnowledgePoint[]> {
  if (picked.length === 0) return [];
  const ids = picked.map((point) => point.knowledge_id);
  const names = await db
    .select({ id: knowledge.id, name: knowledge.name })
    .from(knowledge)
    .where(inArray(knowledge.id, ids));
  const mastery = await getMasteryProjection(db, ids);
  const nameById = new Map(names.map((row) => [row.id, row.name]));
  return picked.map((point) => {
    const projection = mastery.get(point.knowledge_id);
    const band =
      projection && projection.evidence_count > 0 && Number.isFinite(projection.mastery)
        ? A5_BANDS[masteryBandIdx(projection.mastery)]
        : null;
    return {
      knowledge_id: point.knowledge_id,
      name: nameById.get(point.knowledge_id) ?? null,
      overdue_days: point.overdue_days,
      retention: point.retention,
      mastery_band: band,
    };
  });
}

export async function resolveDailyReviewPlanInputs(
  db: DbLike,
  now: Date = new Date(),
): Promise<DailyReviewPlanInputs> {
  const reader = installedHostOperation<ReadDailyReviewPlanFacts>(FACT_READER_SLOT);
  if (!reader) {
    throw new Error(
      'daily review plan facts are not installed; call installDailyReviewPlanFacts before Coach reads the plan',
    );
  }
  const facts = await reader(db, now);
  const seen = new Set<string>();
  const dueRows = facts.due_rows.filter((row) => {
    if (seen.has(row.question_id)) return false;
    seen.add(row.question_id);
    return true;
  });
  const subjectByQuestion = await batchResolveSubjectIds(
    db,
    dueRows.map((row) => ({
      id: row.question_id,
      knowledge_ids: [...(row.knowledge_ids ?? [])],
    })),
  );
  const dueKnowledge = await labelDueKnowledge(db, selectDueKnowledge(dueRows, now));
  // Every due question must land in one bucket: otherwise the mix denominator
  // would leave unresolved questions out and over-allocate to resolved subjects.
  const fallbackSubjectId = resolveSubjectProfile(null).id;
  const dueBySubject = new Map<string, number>();
  for (const row of dueRows) {
    const subjectId = subjectByQuestion.get(row.question_id) ?? fallbackSubjectId;
    dueBySubject.set(subjectId, (dueBySubject.get(subjectId) ?? 0) + 1);
  }
  const dueBySubjectRows = [...dueBySubject.entries()]
    .map(([subject_id, due_count]) => ({ subject_id, due_count }))
    .sort((a, b) => a.subject_id.localeCompare(b.subject_id));

  return {
    due_count: dueBySubjectRows.reduce((sum, row) => sum + row.due_count, 0),
    due_by_subject: dueBySubjectRows,
    due_knowledge: dueKnowledge,
    budget_minutes: facts.budget_minutes,
    question_minutes: facts.question_minutes,
    question_minutes_source: facts.question_minutes_source,
    question_minutes_sample_count: facts.question_minutes_sample_count,
  };
}
