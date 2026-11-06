// GET /api/appeals/{id} — learner-safe appeal/rejudge status projection.
// Reads the appeal event + its resolution receipt + the pg-boss `rejudge` row —
// the same records the appeal write and worker already own; no new run system.

import { and, desc, eq, sql } from 'drizzle-orm';
import { EvaluationRecord } from '@/core/schema/assessment';
import type { ScoringBasisT } from '@/core/schema/assessment/scoring';
import type { Db } from '@/db/client';
import { evaluation, event } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { resolveVerdictsForGroups } from '@/kernel/read-models/assessment-verdict';
import { projectEvaluationToJudgeResult } from '../../grading/public';

const APPEAL_ACTION = 'experimental:appeal_request';
const RESOLUTION_ACTION = 'experimental:assessment_appeal_resolution';

export type AppealStatusKind = 'in_progress' | 'changed' | 'unchanged' | 'unjudgeable' | 'failed';

interface ProjectedVerdict {
  coarse_outcome: string;
  score: number | null;
  feedback_md: string | null;
}

function projectEval(row: typeof evaluation.$inferSelect, basis: ScoringBasisT): ProjectedVerdict {
  const result = projectEvaluationToJudgeResult(EvaluationRecord.parse(row), basis);
  return {
    coarse_outcome: result.coarse_outcome,
    score: result.score,
    feedback_md: result.feedback_md ?? null,
  };
}

/**
 * pg-boss delivery state for this appeal's `rejudge` job. A job row may legitimately
 * be absent (enqueue flag off, or a completed delivery pruned by keep_completed) —
 * absence alone is not a failure signal, only an explicit `failed`/`dlq` row is.
 */
async function rejudgeJobState(db: Db, appealEventId: string): Promise<string | null> {
  const [schema] = await db.execute<{ present: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pgboss') AS present
  `);
  if (!schema?.present) return null;
  const [job] = await db.execute<{ state: string }>(sql`
    SELECT state FROM pgboss.job
    WHERE name = 'rejudge' AND data->>'appeal_event_id' = ${appealEventId}
    ORDER BY created_on DESC LIMIT 1
  `);
  return job?.state ?? null;
}

export async function readAppealStatus(database: Db, appealEventId: string) {
  const [appeal] = await database
    .select()
    .from(event)
    .where(and(eq(event.id, appealEventId), eq(event.action, APPEAL_ACTION)))
    .limit(1);
  if (appeal?.subject_kind !== 'evaluation' || !appeal.subject_id) {
    throw new ApiError('not_found', 'appeal not found', 404);
  }
  const groupId =
    typeof appeal.payload.evaluation_group_id === 'string'
      ? appeal.payload.evaluation_group_id
      : null;
  const reason = typeof appeal.payload.reason_md === 'string' ? appeal.payload.reason_md : '';

  const [resolution] = await database
    .select()
    .from(event)
    .where(and(eq(event.caused_by_event_id, appeal.id), eq(event.action, RESOLUTION_ACTION)))
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(1);
  const disposition =
    typeof resolution?.payload.disposition === 'string' ? resolution.payload.disposition : null;
  const candidateId =
    typeof resolution?.payload.evaluation_id === 'string' ? resolution.payload.evaluation_id : null;

  const [appealedEval, group] = await Promise.all([
    database
      .select()
      .from(evaluation)
      .where(eq(evaluation.evaluation_id, appeal.subject_id))
      .limit(1),
    groupId !== null ? resolveVerdictsForGroups(database, [groupId]) : Promise.resolve(new Map()),
  ]);
  const groupVerdict = groupId !== null ? group.get(groupId) : undefined;
  const basis =
    groupVerdict?.effective?.scoring_basis ?? groupVerdict?.original?.scoring_basis ?? null;

  const before = appealedEval[0] && basis ? projectEval(appealedEval[0], basis) : null;

  // `after` = the candidate this rejudge produced (whether activated or held).
  // `effective_evaluation_id` is read off the live head so an unjudgeable/failed
  // outcome still names the result that remains in force.
  let after: (ProjectedVerdict & { effective_evaluation_id: string | null }) | null = null;
  if (candidateId !== null) {
    const [candidate] = await database
      .select()
      .from(evaluation)
      .where(eq(evaluation.evaluation_id, candidateId))
      .limit(1);
    if (candidate && basis) {
      after = {
        ...projectEval(candidate, basis),
        effective_evaluation_id: groupVerdict?.head?.effective_evaluation_id ?? null,
      };
    }
  }

  let status: AppealStatusKind;
  if (disposition === null) {
    status = (await rejudgeJobState(database, appeal.id)) === 'failed' ? 'failed' : 'in_progress';
  } else if (disposition === 'effective') {
    status =
      after !== null &&
      before !== null &&
      after.coarse_outcome === before.coarse_outcome &&
      after.score === before.score
        ? 'unchanged'
        : 'changed';
  } else if (disposition === 'review_required') {
    status = 'unjudgeable';
  } else {
    status = 'failed';
  }

  return {
    appeal_event_id: appeal.id,
    status,
    evaluation_id: appeal.subject_id,
    evaluation_group_id: groupId,
    reason_md: reason,
    submitted_at_sec: Math.floor(appeal.created_at.getTime() / 1000),
    before,
    after,
    disposition,
  };
}
