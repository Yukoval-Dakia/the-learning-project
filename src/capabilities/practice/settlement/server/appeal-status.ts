// GET /api/appeals/{id} — learner-safe appeal/rejudge status projection.
// Reads the appeal event + its resolution receipt + the pg-boss `rejudge` row —
// the same records the appeal write and worker already own; no new run system.

import { and, desc, eq, sql } from 'drizzle-orm';
import { EvaluationRecord } from '@/core/schema/assessment';
import type { ScoringBasisT } from '@/core/schema/assessment/scoring';
import type { Db } from '@/db/client';
import { evaluation, event, learning_session } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { resolveVerdictsForGroups } from '@/kernel/read-models/assessment-verdict';
import { assessmentAttemptEventId } from '@/kernel/records/assessment-attempt-identity';
import { RETENTION_7D } from '@/server/boss/queue-config';
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
 * pg-boss delivery state for this appeal's `rejudge` job. The data payload only
 * exists on `rejudge` sends, so matching by `appeal_event_id` alone also catches
 * the `*_dlq` row the job lands on once retries are exhausted (the queue move
 * rewrites `name`). A row may legitimately be absent (enqueue flag off, or a
 * completed delivery pruned by retention) — absence alone is not a failure
 * signal until the row outlives queue retention, after which an unresolved
 * appeal can never produce a resolution on its own.
 */
async function rejudgeJobState(
  db: Db,
  appealEventId: string,
): Promise<'failed' | 'absent' | 'live'> {
  const [schema] = await db.execute<{ present: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pgboss') AS present
  `);
  if (!schema?.present) return 'absent';
  const [job] = await db.execute<{ name: string; state: string }>(sql`
    SELECT name, state FROM pgboss.job
    WHERE data->>'appeal_event_id' = ${appealEventId}
    ORDER BY created_on DESC LIMIT 1
  `);
  if (!job) return 'absent';
  if (job.name.endsWith('_dlq') || job.state === 'failed' || job.state === 'cancelled')
    return 'failed';
  return 'live';
}

/**
 * judge_now_show_later 反馈封锁（与 assessment-verdict 同一判定）：判分缓冲到
 * session 完成，考中不可见 ⇒ 只回状态，不回判词/分数。同一 occurrence 判定靠
 * attempt payload 的 `paper_started_at` 对 `learning_session.started_at` —— 重开
 * 卷换 started_at，旧 occurrence 的缓冲不解锁。
 */
async function appealFeedbackLocked(db: Db, submissionId: string): Promise<boolean> {
  const [anchor] = await db
    .select({ session_id: event.session_id, payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.id, assessmentAttemptEventId(submissionId)),
        eq(event.action, 'experimental:assessment_attempt'),
      ),
    )
    .limit(1);
  if (anchor?.payload.paper_feedback_policy !== 'judge_now_show_later') return false;
  const paperStartedAt = anchor.payload.paper_started_at;
  if (typeof paperStartedAt !== 'string' || anchor.session_id === null) return true;
  const [session] = await db
    .select({ status: learning_session.status, started_at: learning_session.started_at })
    .from(learning_session)
    .where(eq(learning_session.id, anchor.session_id))
    .limit(1);
  return session?.status !== 'completed' || session.started_at.toISOString() !== paperStartedAt;
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
  // The rejudge owner records the changed/unchanged decision on the receipt —
  // it is the only side holding the before record, the after record and the
  // activation result. Receipts predating the field carry no `verdict_change`;
  // the read model falls back to the coarse+score comparison below, which is
  // documented to under-report partial_unknown count flips on legacy rows.
  const verdictChange =
    resolution?.payload.verdict_change === 'changed' ||
    resolution?.payload.verdict_change === 'unchanged'
      ? resolution.payload.verdict_change
      : null;

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
    const jobState = await rejudgeJobState(database, appeal.id);
    status =
      jobState === 'failed' ||
      (jobState === 'absent' && appeal.created_at.getTime() + RETENTION_7D * 1000 < Date.now())
        ? 'failed'
        : 'in_progress';
  } else if (disposition === 'effective') {
    status =
      after === null
        ? 'failed'
        : (verdictChange ??
          (before !== null &&
          after.coarse_outcome === before.coarse_outcome &&
          after.score === before.score
            ? 'unchanged'
            : 'changed'));
  } else if (disposition === 'review_required') {
    status = 'unjudgeable';
  } else {
    status = 'failed';
  }

  const locked = appealedEval[0]
    ? await appealFeedbackLocked(database, appealedEval[0].submission_id)
    : false;

  return {
    appeal_event_id: appeal.id,
    status,
    evaluation_id: appeal.subject_id,
    evaluation_group_id: groupId,
    reason_md: reason,
    submitted_at_sec: Math.floor(appeal.created_at.getTime() / 1000),
    before: locked ? null : before,
    after: locked ? null : after,
    feedback_buffered: locked,
    disposition,
  };
}
