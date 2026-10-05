import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { canonicalHash } from '@/core/migration/canonical';
import { JudgePendingAttemptPayload } from '@/core/schema/event/judge-pending-events';
import type { Tx } from '@/db/client';
import {
  assessment_issuance,
  evaluation,
  evaluation_effective_head,
  event,
  job_events,
  question,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import { PlacementQuestionSchema } from '../api/placement-contracts';
import { issueAssessment } from './assessment/issue';
import { getIssuanceState } from './assessment/submit';
import { JUDGE_RUN_TABLE, deriveJudgeRunStatus } from './judge-run-status';
import { type SelectPlacementItemInput, selectNextPlacementItem } from './placement-select';

const ACTION = 'experimental:assessment_placement_issued';
const PlacementIssueReceipt = z.object({
  ordinal: z.number().int().positive(),
  questionId: z.string(),
  score: z.number(),
  scoreKind: z.enum(['mfi', 'klp', 'klp_grid']),
  issuance_id: z.string(),
  evaluation_group_id: z.string(),
  submission_id: z.string(),
  idempotency_key: z.string(),
});
type Receipt = z.infer<typeof PlacementIssueReceipt>;

/** Called under the placement session row lock. Verdicts never enter this public read model. */
export async function placementAssessmentProgress(tx: Tx, sessionId: string) {
  const answered = await tx
    .select({ questionId: event.subject_id })
    .from(event)
    .where(
      and(
        eq(event.session_id, sessionId),
        eq(event.subject_kind, 'question'),
        inArray(event.action, ['review', 'attempt', 'experimental:assessment_attempt']),
      ),
    );
  const answeredIds = new Set(answered.map((row) => row.questionId));
  const issued = await tx
    .select({ issuanceId: assessment_issuance.issuance_id, payload: event.payload })
    .from(assessment_issuance)
    .innerJoin(
      event,
      and(
        eq(event.subject_id, assessment_issuance.issuance_id),
        eq(event.action, ACTION),
        eq(event.session_id, sessionId),
      ),
    )
    .where(eq(assessment_issuance.container_occurrence_ref, `placement:${sessionId}`))
    .orderBy(asc(assessment_issuance.issued_at), asc(assessment_issuance.issuance_id));
  let outstanding: z.infer<typeof PlacementQuestionSchema> | null = null;
  for (const row of issued) {
    const receipt = PlacementIssueReceipt.parse(row.payload);
    if (receipt.issuance_id !== row.issuanceId)
      throw new ApiError('corrupt_state', 'placement issuance receipt mismatch', 409);
    const state = await getIssuanceState(tx, row.issuanceId);
    const accepted = state.submissions[0];
    if (!accepted && answeredIds.has(receipt.questionId)) continue;
    let phase: 'answering' | 'retry' | 'pending' | 'held' = 'answering';
    let pendingRun: { run_id: string; poll_url: string } | null = null;
    if (accepted) {
      answeredIds.add(receipt.questionId);
      const [head] = await tx
        .select()
        .from(evaluation_effective_head)
        .where(eq(evaluation_effective_head.evaluation_group_id, accepted.evaluation_group_id));
      const settlements = head?.effective_evaluation_id
        ? await tx
            .select({ payload: event.payload })
            .from(event)
            .where(
              and(
                eq(event.action, 'experimental:assessment_settlement'),
                eq(event.subject_id, accepted.evaluation_group_id),
              ),
            )
            .orderBy(desc(event.created_at), desc(event.id))
        : [];
      // A moved head alone is insufficient: failed_pending/replay_required remains held.
      const settlement = settlements.find(
        (r) => r.payload?.evaluation_id === head?.effective_evaluation_id,
      );
      if (
        head?.submission_id === accepted.submission_id &&
        (settlement?.payload?.effect === 'applied' || settlement?.payload?.effect === 'ineligible')
      )
        continue;
      const candidates = await tx
        .select({ id: evaluation.evaluation_id })
        .from(evaluation)
        .where(eq(evaluation.submission_id, accepted.submission_id));
      const pending = await tx
        .select({ payload: event.payload })
        .from(event)
        .where(
          and(
            eq(event.action, 'experimental:judge_pending_attempt'),
            eq(event.session_id, sessionId),
            sql`${event.payload}->'submit'->>'submission_id' = ${accepted.submission_id}`,
          ),
        );
      const payload = pending[0] ? JudgePendingAttemptPayload.parse(pending[0].payload) : null;
      const [resolution] =
        payload?.caller === 'native_assessment'
          ? await tx
              .select({ id: event.id })
              .from(event)
              .where(
                and(
                  eq(event.id, payload.run_id),
                  eq(event.action, 'experimental:assessment_judge_resolution'),
                ),
              )
          : [];
      if (payload?.caller === 'native_assessment') {
        const jobs = await tx
          .select({ event_type: job_events.event_type, payload: job_events.payload })
          .from(job_events)
          .where(
            and(
              eq(job_events.business_table, JUDGE_RUN_TABLE),
              eq(job_events.business_id, payload.run_id),
            ),
          )
          .orderBy(asc(job_events.id));
        const status = deriveJudgeRunStatus(jobs);
        phase = resolution || status === 'done' || status === 'failed' ? 'held' : 'pending';
        if (phase === 'pending')
          pendingRun = {
            run_id: payload.run_id,
            poll_url: `/api/jobs/judge_run/${encodeURIComponent(payload.run_id)}/status`,
          };
      } else phase = candidates.length || head?.effective_evaluation_id ? 'held' : 'retry';
    }
    // Never select past a persisted original awaiting evaluation or settlement.
    outstanding ??= PlacementQuestionSchema.parse({
      questionId: receipt.questionId,
      score: receipt.score,
      scoreKind: receipt.scoreKind,
      assessment: { ...receipt, state, phase, pending_run: pendingRun },
    });
  }
  return {
    answeredIds: [...answeredIds],
    answeredCount: answeredIds.size,
    outstanding,
    issuedCount: issued.length,
  };
}

/** Reuse the outstanding issuance before selecting; new identities belong to a session ordinal. */
export async function ensurePlacementAssessment(
  tx: Tx,
  sessionId: string,
  input: SelectPlacementItemInput,
  progress: Awaited<ReturnType<typeof placementAssessmentProgress>>,
) {
  if (progress.outstanding) return progress.outstanding;
  const exclude = new Set([...progress.answeredIds, ...(input.excludeQuestionIds ?? [])]);
  for (let attempt = 0; attempt < 200; attempt++) {
    const selection = await selectNextPlacementItem(tx, {
      ...input,
      excludeQuestionIds: [...exclude],
    });
    if (!selection) return null;
    const [q] = await tx
      .select({ id: question.id, parentId: question.parent_question_id })
      .from(question)
      .where(eq(question.id, selection.questionId));
    if (!q) {
      exclude.add(selection.questionId);
      continue;
    }
    const rootId = q.parentId ?? q.id;
    const [lifecycle] = await tx
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, rootId));
    const [revision] = lifecycle?.current_revision_id
      ? await tx
          .select()
          .from(question_revision)
          .where(eq(question_revision.revision_id, lifecycle.current_revision_id))
      : [];
    if (!revision) {
      exclude.add(q.id);
      continue;
    }
    const partIds = q.parentId ? [q.id] : revision.structure.parts.map((part) => part.part_id);
    const ordinal = progress.issuedCount + 1;
    const identity = canonicalHash({ sessionId, ordinal });
    const issued = await issueAssessment(tx, {
      issuance_id: `iss_placement_${identity}`,
      group_id: rootId,
      revision_id: revision.revision_id,
      part_ids: partIds,
      container_occurrence_ref: `placement:${sessionId}`,
      actorRef: 'assessment:placement',
    });
    if (issued.status !== 'issued' && issued.status !== 'replayed') {
      if (
        ['suspended', 'withdrawn', 'not_admitted', 'unpublished', 'not_found'].includes(
          issued.status,
        )
      ) {
        exclude.add(q.id);
        continue;
      }
      throw new ApiError(issued.status, `placement issuance unavailable: ${issued.status}`, 409);
    }
    const receipt: Receipt = PlacementIssueReceipt.parse({
      ...selection,
      ordinal,
      issuance_id: issued.issuance.issuance_id,
      evaluation_group_id: `eg_placement_${identity}`,
      submission_id: `sub_placement_${identity}`,
      idempotency_key: `placement_${identity}`,
    });
    await writeEvent(tx, {
      id: `evt_placement_${identity}`,
      session_id: sessionId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: ACTION,
      subject_kind: 'issuance',
      subject_id: receipt.issuance_id,
      outcome: null,
      payload: receipt,
    });
    return PlacementQuestionSchema.parse({
      ...selection,
      assessment: {
        ...receipt,
        state: await getIssuanceState(tx, receipt.issuance_id),
        phase: 'answering',
        pending_run: null,
      },
    });
  }
  return null;
}

/** The placement occurrence's immutable coordinates also fence shared /attempts writes. */
export async function validatePlacementSubmission(
  database: import('@/db/client').Db,
  questionId: string,
  sessionId: string | null | undefined,
  input: import('./assessment/submit').SaveSubmissionRequest,
) {
  const [issuance] = await database
    .select({ container: assessment_issuance.container_occurrence_ref })
    .from(assessment_issuance)
    .where(eq(assessment_issuance.issuance_id, input.issuance_id));
  if (!issuance?.container?.startsWith('placement:')) return;
  if (!sessionId || issuance.container !== `placement:${sessionId}`)
    throw new ApiError('coordinate_mismatch', 'placement issuance belongs to another session', 409);
  const [row] = await database
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, ACTION),
        eq(event.subject_id, input.issuance_id),
        eq(event.session_id, sessionId),
      ),
    );
  const receipt = PlacementIssueReceipt.parse(row?.payload);
  if (
    receipt.questionId !== questionId ||
    receipt.evaluation_group_id !== input.evaluation_group_id ||
    receipt.submission_id !== input.submission_id ||
    receipt.idempotency_key !== input.idempotency_key
  )
    throw new ApiError(
      'coordinate_mismatch',
      'placement submission differs from its issued occurrence',
      409,
    );
}
